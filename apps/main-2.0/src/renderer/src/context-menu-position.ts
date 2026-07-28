import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export interface ContextMenuPoint {
  x: number;
  y: number;
}

const VIEWPORT_PADDING = 8;

export function clampedContextMenuPosition(
  point: ContextMenuPoint,
  menuSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
): ContextMenuPoint {
  return {
    x: clamp(point.x, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, viewportSize.width - menuSize.width - VIEWPORT_PADDING)),
    y: clamp(point.y, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, viewportSize.height - menuSize.height - VIEWPORT_PADDING)),
  };
}

export function useClampedContextMenuStyle(point: ContextMenuPoint): {
  ref: React.RefObject<HTMLDivElement | null>;
  style: CSSProperties;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ContextMenuPoint>(point);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      setPosition(point);
      return;
    }
    const rect = element.getBoundingClientRect();
    setPosition(
      clampedContextMenuPosition(
        point,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [point]);

  return {
    ref,
    style: { left: position.x, top: position.y },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
