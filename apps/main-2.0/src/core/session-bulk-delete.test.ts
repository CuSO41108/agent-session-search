import { describe, expect, it } from "vitest";
import {
  isSessionDeleteConfirmationRequiredMessage,
  normalizeSessionDeleteOptions,
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
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
  });

  it("normalizes omitted and confirmed deletion options", () => {
    expect(normalizeSessionDeleteOptions(undefined)).toEqual({
      confirmed: false,
      allowLiveSessions: false,
    });
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
  ])("rejects invalid deletion options: %j", (options) => {
    expect(() => normalizeSessionDeleteOptions(options)).toThrow(
      "The session deletion options are invalid.",
    );
  });
});
