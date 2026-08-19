import { describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_WEB_STORAGE_KEY,
  DEEPSEEK_WEB_URL,
  openDeepSeekWebSessionPage,
} from "./deepseek-web-session";

describe("openDeepSeekWebSessionPage", () => {
  it("selects the requested session before showing the web page", async () => {
    const calls: string[] = [];
    const page = {
      loadURL: vi.fn(async (url: string) => { calls.push(`load:${url}`); }),
      executeJavaScript: vi.fn(async (script: string) => { calls.push(`script:${script}`); }),
      show: vi.fn(() => { calls.push("show"); }),
      focus: vi.fn(() => { calls.push("focus"); }),
    };

    await openDeepSeekWebSessionPage(page, "session-1");

    expect(calls).toEqual([
      `load:${DEEPSEEK_WEB_URL}`,
      `script:localStorage.setItem(${JSON.stringify(DEEPSEEK_WEB_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify({ sessionId: "session-1" }))})`,
      `load:${DEEPSEEK_WEB_URL}`,
      "show",
      "focus",
    ]);
  });

  it("quotes an untrusted session id as data in the storage script", async () => {
    const page = {
      loadURL: vi.fn(async () => undefined),
      executeJavaScript: vi.fn(async () => undefined),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const sessionId = `session-\";globalThis.compromised=true;//`;

    await openDeepSeekWebSessionPage(page, sessionId);

    expect(page.executeJavaScript).toHaveBeenCalledWith(
      `localStorage.setItem(${JSON.stringify(DEEPSEEK_WEB_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify({ sessionId }))})`,
    );
  });
});
