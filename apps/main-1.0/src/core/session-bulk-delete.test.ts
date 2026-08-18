import { describe, expect, it } from "vitest";
import {
  isSessionDeleteConfirmationRequiredMessage,
  normalizeSessionDeleteOptions,
  SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD,
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
} from "./session-bulk-delete";

describe("session deletion options", () => {
  it("uses ten sessions as the typed bulk confirmation threshold", () => {
    expect(SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD).toBe(10);
  });

  it("recognizes bare and Electron-wrapped confirmation errors", () => {
    expect(isSessionDeleteConfirmationRequiredMessage(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    )).toBe(true);
    expect(isSessionDeleteConfirmationRequiredMessage(
      `Error invoking remote method 'session:bulk-delete': Error: ${SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE}`,
    )).toBe(true);
    expect(isSessionDeleteConfirmationRequiredMessage(
      `${SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE} Retry later.`,
    )).toBe(false);
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
