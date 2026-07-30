import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionIndexFailureDiagnostic } from "../core/indexer";

const DEFAULT_MAX_BYTES = 1024 * 1024;

interface SessionIndexFailureLoggerOptions {
  maxBytes?: number;
  now?: () => Date;
}

export interface SessionIndexFailureLogger {
  logPath: string;
  write: (diagnostic: SessionIndexFailureDiagnostic) => Promise<void>;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createSessionIndexFailureLogger(
  userDataPath: string,
  options: SessionIndexFailureLoggerOptions = {},
): SessionIndexFailureLogger {
  const logDirectory = path.join(userDataPath, "logs");
  const logPath = path.join(logDirectory, "session-index-failures.jsonl");
  const previousLogPath = path.join(logDirectory, "session-index-failures.previous.jsonl");
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const now = options.now ?? (() => new Date());

  return {
    logPath,
    write: async (diagnostic) => {
      await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(logDirectory, 0o700);

      try {
        const current = await fs.stat(logPath);
        if (current.size >= maxBytes) {
          await fs.rm(previousLogPath, { force: true });
          await fs.rename(logPath, previousLogPath);
        }
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }

      const record = {
        timestamp: now().toISOString(),
        source: diagnostic.source,
        sessionKey: diagnostic.sessionKey,
        filePath: diagnostic.filePath,
        error: {
          name: diagnostic.error.name,
          message: diagnostic.error.message,
          stack: diagnostic.error.stack,
        },
      };
      await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") await fs.chmod(logPath, 0o600);
    },
  };
}
