import { describe, expect, it } from "vitest";
import {
  isSessionDeleteConfirmationRequiredMessage,
  isSessionDeleteLiveCheckConfirmationRequiredMessage,
  normalizeSessionDeleteOptions,
  SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD,
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE,
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
    expect(isSessionDeleteLiveCheckConfirmationRequiredMessage(
      `Error invoking remote method 'session:delete': Error: ${SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE}`,
    )).toBe(true);
  });

  it("defaults every confirmation permission to false", () => {
    expect(normalizeSessionDeleteOptions(undefined)).toEqual({
      confirmed: false,
      allowLiveSessions: false,
      allowUnverifiedLiveSessions: false,
    });
  });

  it("requires confirmation before live deletion permission can take effect", () => {
    expect(normalizeSessionDeleteOptions({
      confirmed: false,
      allowLiveSessions: true,
    })).toEqual({
      confirmed: false,
      allowLiveSessions: false,
      allowUnverifiedLiveSessions: false,
    });
    expect(normalizeSessionDeleteOptions({
      confirmed: true,
      allowLiveSessions: true,
      allowUnverifiedLiveSessions: false,
    })).toEqual({
      confirmed: true,
      allowLiveSessions: true,
      allowUnverifiedLiveSessions: false,
    });
    expect(normalizeSessionDeleteOptions({
      confirmed: true,
      allowUnverifiedLiveSessions: true,
    })).toEqual({
      confirmed: true,
      allowLiveSessions: false,
      allowUnverifiedLiveSessions: true,
    });
  });

  it.each([
    null,
    "confirmed",
    [],
    { confirmed: "yes" },
    { allowLiveSessions: 1 },
    { allowUnverifiedLiveSessions: "yes" },
  ])("rejects invalid IPC options: %j", (options) => {
    expect(() => normalizeSessionDeleteOptions(options)).toThrow(
      "The session deletion options are invalid.",
    );
  });
});
