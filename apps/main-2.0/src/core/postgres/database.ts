import { Pool } from "pg";

export interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface PostgresQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresClient extends PostgresQueryable {
  release(): void;
}

export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface PostgresMigration {
  version: number;
  name: string;
  statements: readonly string[];
}

interface PostgresDatabaseOptions {
  migrations?: readonly PostgresMigration[];
  migrationLock?: boolean;
}

const MIGRATION_LOCK_ID = 1_970_032_307;

export class PostgresDatabase implements PostgresQueryable {
  private readonly migrations: readonly PostgresMigration[];
  private readonly migrationLock: boolean;
  private initializePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly pool: PostgresPool,
    options: PostgresDatabaseOptions = {},
  ) {
    this.migrations = [...(options.migrations ?? [])].sort((left, right) => left.version - right.version);
    this.migrationLock = options.migrationLock ?? true;
    this.pool.on?.("error", (error) => this.handlePoolError(error));
  }

  static connect(connectionUrl: string, options: PostgresDatabaseOptions = {}): PostgresDatabase {
    const pool = new Pool({
      connectionString: connectionUrl,
      max: 8,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: "agent-recall-v2",
    });
    return new PostgresDatabase(pool as unknown as PostgresPool, options);
  }

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("PostgreSQL database is closed"));
    this.initializePromise ??= this.applyMigrations();
    return this.initializePromise;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    if (this.closed) throw new Error("PostgreSQL database is closed");
    return this.pool.query<Row>(text, values);
  }

  async transaction<T>(run: (client: PostgresQueryable) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("PostgreSQL database is closed");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the operation error. A broken connection will be discarded by pg.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.pool.end();
    return this.closePromise;
  }

  private handlePoolError(error: Error): void {
    if (this.closed && isPostgresShutdownError(error)) return;
    const detail = redactPostgresConnectionText(error.stack ?? error.message);
    console.warn(`PostgreSQL background connection failed: ${detail}`);
  }

  private async applyMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (this.migrationLock) await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query("CREATE SCHEMA IF NOT EXISTS agent_recall");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_recall.schema_migrations (
          version integer PRIMARY KEY,
          name text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const applied = await client.query<{ version: number }>(
        "SELECT version FROM agent_recall.schema_migrations",
      );
      const appliedVersions = new Set(applied.rows.map((row) => Number(row.version)));
      for (const migration of this.migrations) {
        if (appliedVersions.has(migration.version)) continue;
        await client.query("BEGIN");
        try {
          for (const statement of migration.statements) await client.query(statement);
          await client.query(
            "INSERT INTO agent_recall.schema_migrations (version, name) VALUES ($1, $2)",
            [migration.version, migration.name],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      if (this.migrationLock) {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
        } catch {
          // Releasing the connection also releases session advisory locks.
        }
      }
      client.release();
    }
  }
}

function isPostgresShutdownError(error: Error): boolean {
  const code = (error as Error & { code?: unknown }).code;
  if (code === "57P01") return true;
  return /terminating connection due to administrator command|connection terminated unexpectedly/iu.test(error.message);
}

export function redactPostgresConnectionText(text: string): string {
  return text.replace(
    /\b(postgres(?:ql)?:\/\/)([^@\s/]+)@/giu,
    "$1[redacted]@",
  );
}
