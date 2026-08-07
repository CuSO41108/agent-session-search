import { describe, expect, it, vi } from "vitest";
import {
  PostgresDatabase,
  redactPostgresConnectionText,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
} from "./database";
import { PGliteTestPool } from "./test-pglite";

class ControlledPostgresPool implements PostgresPool {
  private errorListener: ((error: Error) => void) | undefined;
  private resolveEndPromise: (() => void) | undefined;
  readonly endPromise = new Promise<void>((resolve) => {
    this.resolveEndPromise = resolve;
  });
  endCalls = 0;

  async query<Row extends Record<string, unknown>>(): Promise<PostgresQueryResult<Row>> {
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PostgresClient> {
    throw new Error("connect should not be called");
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return this.endPromise;
  }

  on(event: "error", listener: (error: Error) => void): void {
    if (event === "error") this.errorListener = listener;
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }

  finishEnd(): void {
    this.resolveEndPromise?.();
  }
}

describe("PostgresDatabase", () => {
  it("applies versioned migrations exactly once", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: [{
        version: 1,
        name: "create test values",
        statements: [
          "create schema if not exists agent_recall",
          "create table agent_recall.test_values (value text primary key)",
        ],
      }],
    });

    await database.initialize();
    await database.initialize();

    const migrations = await database.query<{ version: number; name: string }>(
      "select version, name from agent_recall.schema_migrations order by version",
    );
    expect(migrations.rows).toEqual([{ version: 1, name: "create test values" }]);
    await database.close();
  });

  it("commits successful transactions and rolls back failed transactions", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: [{
        version: 1,
        name: "create test values",
        statements: [
          "create schema if not exists agent_recall",
          "create table agent_recall.test_values (value text primary key)",
        ],
      }],
    });
    await database.initialize();

    await database.transaction(async (client) => {
      await client.query("insert into agent_recall.test_values (value) values ($1)", ["kept"]);
    });
    await expect(database.transaction(async (client) => {
      await client.query("insert into agent_recall.test_values (value) values ($1)", ["discarded"]);
      throw new Error("stop");
    })).rejects.toThrow("stop");

    const values = await database.query<{ value: string }>(
      "select value from agent_recall.test_values order by value",
    );
    expect(values.rows).toEqual([{ value: "kept" }]);
    await database.close();
  });

  it("removes PostgreSQL credentials from diagnostics", () => {
    const text = "connect ECONNREFUSED postgresql://agent:very-secret@private.example:5432/recall";
    expect(redactPostgresConnectionText(text)).toBe(
      "connect ECONNREFUSED postgresql://[redacted]@private.example:5432/recall",
    );
  });

  it("shares one close operation across concurrent shutdown callers", async () => {
    const pool = new ControlledPostgresPool();
    const database = new PostgresDatabase(pool);

    const firstClose = database.close();
    const secondClose = database.close();

    expect(secondClose).toBe(firstClose);
    expect(pool.endCalls).toBe(1);
    pool.finishEnd();
    await Promise.all([firstClose, secondClose]);
  });

  it("handles background pool errors and suppresses expected shutdown disconnects", async () => {
    const pool = new ControlledPostgresPool();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const database = new PostgresDatabase(pool);

    pool.emitError(new Error("Connection terminated unexpectedly"));
    expect(warn).toHaveBeenCalledOnce();

    const closing = database.close();
    pool.emitError(Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    ));
    expect(warn).toHaveBeenCalledOnce();

    pool.finishEnd();
    await closing;
    warn.mockRestore();
  });

  it("classifies close-race errors only after closing begins", async () => {
    const pool = new ControlledPostgresPool();
    const database = new PostgresDatabase(pool);
    const shutdownError = Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    );
    const closedError = new Error("PostgreSQL database is closed");
    const terminatedError = new Error("Connection terminated unexpectedly");

    expect(database.isClosedError(shutdownError)).toBe(false);
    expect(database.isClosedError(closedError)).toBe(false);
    expect(database.isClosedError("57P01")).toBe(false);

    const closing = database.close();

    expect(database.isClosedError(shutdownError)).toBe(true);
    expect(database.isClosedError(closedError)).toBe(true);
    expect(database.isClosedError(terminatedError)).toBe(true);
    expect(database.isClosedError(new Error("syntax error"))).toBe(false);

    pool.finishEnd();
    await closing;
  });
});
