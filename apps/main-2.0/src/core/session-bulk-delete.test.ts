import { describe, expect, it } from "vitest";
import { normalizeSessionDeleteOptions } from "./session-bulk-delete";

describe("normalizeSessionDeleteOptions", () => {
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
