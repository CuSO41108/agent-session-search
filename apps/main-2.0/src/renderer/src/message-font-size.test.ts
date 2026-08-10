// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  MESSAGE_FONT_SIZE_BASE_PX,
  applyMessageFontSize,
  messageFontSizeCss,
  messageFontSizePx,
  messageFontSizeZoom,
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

  it("maps each appearance preset to a whole-UI zoom factor", () => {
    expect(messageFontSizeZoom("medium")).toBe(1);
    expect(messageFontSizeZoom("medium-large")).toBe(13 / MESSAGE_FONT_SIZE_BASE_PX);
    expect(messageFontSizeZoom("large")).toBe(14 / MESSAGE_FONT_SIZE_BASE_PX);
    expect(messageFontSizeZoom("xlarge")).toBe(16 / MESSAGE_FONT_SIZE_BASE_PX);
  });

  it("keeps viewport layout unscaled while requesting native page zoom", () => {
    const root = document.createElement("html");
    root.style.zoom = "1.5";
    const requestedZoom: number[] = [];

    applyMessageFontSize("large", (factor) => requestedZoom.push(factor), root);

    expect(root.style.getPropertyValue("--message-font-size")).toBe("12px");
    expect(root.style.zoom).toBe("");
    expect(requestedZoom).toEqual([14 / MESSAGE_FONT_SIZE_BASE_PX]);
  });
});
