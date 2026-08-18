import { describe, expect, it } from "vitest";
import {
  normalizeSessionDeleteOptions,
  SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD,
} from "./session-bulk-delete";

describe("session deletion options", () => {
  it("uses ten sessions as the typed bulk confirmation threshold", () => {
    expect(SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD).toBe(10);
  });

  it("defaults both confirmation permissions to false", () => {
    expect(normalizeSessionDeleteOptions(undefined)).toEqual({
      confirmed: false,
      allowLiveSessions: false,
    });
  });

  it("requires confirmation before live deletion permission can take effect", () => {
    expect(normalizeSessionDeleteOptions({
      confirmed: false,
      allowLiveSessions: true,
    })).toEqual({
      confirmed: false,
      allowLiveSessions: false,
    });
    expect(normalizeSessionDeleteOptions({
      confirmed: true,
      allowLiveSessions: true,
    })).toEqual({
      confirmed: true,
      allowLiveSessions: true,
    });
  });

  it.each([
    null,
    "confirmed",
    [],
    { confirmed: "yes" },
    { allowLiveSessions: 1 },
  ])("rejects invalid IPC options: %j", (options) => {
    expect(() => normalizeSessionDeleteOptions(options)).toThrow(
      "The session deletion options are invalid.",
    );
  });
});
