import { describe, expect, it } from "vitest";
import { initialMessageWindow } from "./message-window";

describe("initialMessageWindow", () => {
  it.each([
    [200, null, { offset: 180, limit: 20 }],
    [200, 100, { offset: 60, limit: 80 }],
    [200, 5, { offset: 0, limit: 80 }],
    [200, 195, { offset: 120, limit: 80 }],
    [12, 6, { offset: 0, limit: 80 }],
  ])("loads a useful window for count=%s and match=%s", (messageCount, matchIndex, expected) => {
    expect(initialMessageWindow(messageCount, matchIndex)).toEqual(expected);
  });
});
