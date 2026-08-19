export const DEEPSEEK_WEB_URL = "http://127.0.0.1:3080/";
export const DEEPSEEK_WEB_STORAGE_KEY = "dsh.sessions.current";

export interface DeepSeekWebSessionPage {
  loadURL(url: string): Promise<unknown>;
  executeJavaScript(script: string): Promise<unknown>;
  show(): void;
  focus(): void;
}

export async function openDeepSeekWebSessionPage(
  page: DeepSeekWebSessionPage,
  sessionId: string,
): Promise<void> {
  await page.loadURL(DEEPSEEK_WEB_URL);
  const selection = JSON.stringify({ sessionId });
  await page.executeJavaScript(
    `localStorage.setItem(${JSON.stringify(DEEPSEEK_WEB_STORAGE_KEY)}, ${JSON.stringify(selection)})`,
  );
  await page.loadURL(DEEPSEEK_WEB_URL);
  page.show();
  page.focus();
}
