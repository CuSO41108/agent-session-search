import { describe, expect, it } from "vitest";
import {
  isSessionDeleteConfirmationRequiredMessage,
  isSessionDeleteLiveCheckConfirmationRequiredMessage,
  normalizeSessionDeleteOptions,
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE,
} from "./session-bulk-delete";

describe("normalizeSessionDeleteOptions", () => {
  it("recognizes bare and Electron-wrapped confirmation errors", () => {
    expect(isSessionDeleteConfirmationRequiredMessage(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    )).toBe(true);
    expect(isSessionDeleteConfirmationRequiredMessage(
      `Error invoking remote method 'session:delete': Error: ${SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE}`,
    )).toBe(true);
    expect(isSessionDeleteConfirmationRequiredMessage(
      `${SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE} Retry later.`,
    )).toBe(false);
    expect(isSessionDeleteLiveCheckConfirmationRequiredMessage(
      `Error invoking remote method 'session:delete': Error: ${SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE}`,
    )).toBe(true);
  });

  it("normalizes omitted and confirmed deletion options", () => {
    expect(normalizeSessionDeleteOptions(undefined)).toEqual({
      confirmed: false,
      allowLiveSessions: false,
      allowUnverifiedLiveSessions: false,
    });
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
  ])("rejects invalid deletion options: %j", (options) => {
    expect(() => normalizeSessionDeleteOptions(options)).toThrow(
      "The session deletion options are invalid.",
    );
  });
});
