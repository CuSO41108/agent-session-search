interface ZoomableWindow {
  isDestroyed(): boolean;
  webContents: {
    setZoomFactor(factor: number): void;
  };
}

const MIN_INTERFACE_ZOOM = 1;
const MAX_INTERFACE_ZOOM = 4 / 3;

export function createInterfaceZoomController(
  resolveWindows: () => readonly (ZoomableWindow | null | undefined)[],
): {
  applyTo(window: ZoomableWindow | null | undefined): void;
  set(value: unknown): number;
} {
  let currentFactor = MIN_INTERFACE_ZOOM;

  const applyTo = (window: ZoomableWindow | null | undefined): void => {
    if (!window || window.isDestroyed()) return;
    window.webContents.setZoomFactor(currentFactor);
  };

  return {
    applyTo,
    set(value: unknown): number {
      currentFactor = normalizeInterfaceZoomFactor(value);
      for (const window of resolveWindows()) applyTo(window);
      return currentFactor;
    },
  };
}

function normalizeInterfaceZoomFactor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MIN_INTERFACE_ZOOM;
  return Math.min(MAX_INTERFACE_ZOOM, Math.max(MIN_INTERFACE_ZOOM, value));
}
