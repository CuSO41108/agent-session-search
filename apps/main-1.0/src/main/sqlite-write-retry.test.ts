import { describe, expect, it, vi } from "vitest";
import { isSqliteBusyError, retrySqliteWrite } from "./sqlite-write-retry";

describe("retrySqliteWrite", () => {
  it("retries SQLite busy failures without blocking the event loop", async () => {
    let attempts = 0;
    let elapsed = 0;
    const delay = vi.fn(async (delayMs: number) => {
      elapsed += delayMs;
    });

    const result = await retrySqliteWrite(() => {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("database is locked"), { errcode: 5 });
      return "saved";
    }, {
      now: () => elapsed,
      delay,
      initialDelayMs: 5,
      maxDelayMs: 20,
      timeoutMs: 100,
    });

    expect(result).toBe("saved");
    expect(attempts).toBe(4);
    expect(delay).toHaveBeenCalledTimes(3);
  });

  it("does not retry unrelated errors", async () => {
    const error = new Error("write rejected");
    await expect(retrySqliteWrite(() => {
      throw error;
    })).rejects.toBe(error);
  });

  it("recognizes SQLite busy error variants", () => {
    expect(isSqliteBusyError(Object.assign(new Error("SQLITE failure"), { errcode: 5 }))).toBe(true);
    expect(isSqliteBusyError(new Error("database is busy"))).toBe(true);
    expect(isSqliteBusyError(new Error("constraint failed"))).toBe(false);
  });
});
