import { describe, expect, it, vi } from "vitest";
import { createInterfaceZoomController } from "./interface-zoom";

function zoomableWindow() {
  return {
    isDestroyed: () => false,
    webContents: { setZoomFactor: vi.fn() },
  };
}

describe("interface zoom controller", () => {
  it("updates every open window and applies the current factor to windows created later", () => {
    const mainWindow = zoomableWindow();
    let quickSearchWindow: ReturnType<typeof zoomableWindow> | null = null;
    const controller = createInterfaceZoomController(() => [mainWindow, quickSearchWindow]);

    expect(controller.set(4 / 3)).toBe(4 / 3);
    expect(mainWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(4 / 3);

    quickSearchWindow = zoomableWindow();
    controller.applyTo(quickSearchWindow);
    expect(quickSearchWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(4 / 3);
  });
});
