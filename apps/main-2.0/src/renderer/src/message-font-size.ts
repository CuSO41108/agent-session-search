export type MessageFontSizeScale = "medium" | "medium-large" | "large" | "xlarge";

export const MESSAGE_FONT_SIZE_STORAGE_KEY = "agent-recall-message-font-size";

export const MESSAGE_FONT_SIZE_SCALES: readonly MessageFontSizeScale[] = [
  "medium",
  "medium-large",
  "large",
  "xlarge",
] as const;

/** Base session/UI body size used as the 1.0 zoom reference. */
export const MESSAGE_FONT_SIZE_BASE_PX = 12;

const MESSAGE_FONT_SIZE_PX: Record<MessageFontSizeScale, number> = {
  medium: 12,
  "medium-large": 13,
  large: 14,
  xlarge: 16,
};

export function readStoredMessageFontSize(value: string | null): MessageFontSizeScale {
  if (value === "small") return "medium";
  if ((MESSAGE_FONT_SIZE_SCALES as readonly string[]).includes(value ?? "")) {
    return value as MessageFontSizeScale;
  }
  return "medium";
}

export function readInitialMessageFontSize(): MessageFontSizeScale {
  if (typeof window === "undefined") return "medium";
  return readStoredMessageFontSize(window.localStorage.getItem(MESSAGE_FONT_SIZE_STORAGE_KEY));
}

export function messageFontSizePx(scale: MessageFontSizeScale): number {
  return MESSAGE_FONT_SIZE_PX[scale];
}

export function messageFontSizeCss(scale: MessageFontSizeScale): string {
  return `${messageFontSizePx(scale)}px`;
}

/** Whole-UI zoom factor. Chromium `zoom` scales hard-coded px layout, not just message text. */
export function messageFontSizeZoom(scale: MessageFontSizeScale): number {
  return messageFontSizePx(scale) / MESSAGE_FONT_SIZE_BASE_PX;
}

export function applyMessageFontSize(scale: MessageFontSizeScale, root: HTMLElement = document.documentElement): void {
  // Keep message body at the base px; page zoom carries the selected scale for the whole UI.
  root.style.setProperty("--message-font-size", `${MESSAGE_FONT_SIZE_BASE_PX}px`);
  root.style.zoom = String(messageFontSizeZoom(scale));
}
