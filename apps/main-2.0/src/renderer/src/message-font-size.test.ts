import { describe, expect, it } from "vitest";
import {
  messageFontSizeCss,
  messageFontSizePx,
  readStoredMessageFontSize,
} from "./message-font-size";

describe("message font size scale", () => {
  it("defaults unknown values to the medium session body size", () => {
    expect(readStoredMessageFontSize(null)).toBe("medium");
    expect(readStoredMessageFontSize("huge")).toBe("medium");
    expect(messageFontSizePx("medium")).toBe(12);
    expect(messageFontSizeCss("medium")).toBe("12px");
  });

  it("downgrades removed small preset to medium", () => {
    expect(readStoredMessageFontSize("small")).toBe("medium");
  });

  it("maps each appearance preset to a concrete message body size", () => {
    expect(readStoredMessageFontSize("medium-large")).toBe("medium-large");
    expect(readStoredMessageFontSize("large")).toBe("large");
    expect(readStoredMessageFontSize("xlarge")).toBe("xlarge");
    expect(messageFontSizePx("medium-large")).toBe(13);
    expect(messageFontSizeCss("medium-large")).toBe("13px");
    expect(messageFontSizePx("large")).toBe(14);
    expect(messageFontSizePx("xlarge")).toBe(16);
    expect(messageFontSizeCss("xlarge")).toBe("16px");
  });
});
