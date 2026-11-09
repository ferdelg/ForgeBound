import { useCallback, useEffect, useRef, useState } from "react";
import * as storage from "../storage";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function readStored(key: string, fallback: number): number {
  try {
    const n = Number(storage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A panel dimension the player can drag, remembered through the storage adapter.
 * `max` may be a function so limits follow the window size.
 */
export function useStoredSize(key: string, initial: number, min: number, max: number | (() => number)) {
  const maxOf = useCallback(() => (typeof max === "function" ? max() : max), [max]);
  const [size, setSize] = useState(() => clamp(readStored(key, initial), min, maxOf()));

  // Re-clamp when the window shrinks so a panel can't swallow the map.
  useEffect(() => {
    const onResize = () => setSize((s) => clamp(s, min, maxOf()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min, maxOf]);

  const set = useCallback((v: number) => setSize(clamp(v, min, maxOf())), [min, maxOf]);
  const persist = useCallback((v: number) => {
    try {
      storage.setItem(key, String(Math.round(v)));
    } catch {
      // ignore — size just won't be remembered
    }
  }, [key]);
  const reset = useCallback(() => {
    const v = clamp(initial, min, maxOf());
    setSize(v);
    persist(v);
  }, [initial, min, maxOf, persist]);

  return { size, set, persist, reset };
}

/**
 * Drag bar on a panel edge. `axis` "x" resizes width (dragging left grows it),
 * "y" resizes height (dragging up grows it); `reverse` flips that, for a bar
 * under the panel it sizes. Double-click restores the default.
 */
export function ResizeHandle({
  axis,
  size,
  onResize,
  onCommit,
  onReset,
  reverse = false,
  className = "",
}: {
  axis: "x" | "y";
  size: number;
  onResize: (v: number) => void;
  onCommit: (v: number) => void;
  onReset: () => void;
  reverse?: boolean;
  className?: string;
}) {
  const drag = useRef<{ start: number; from: number; last: number } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: axis === "x" ? e.clientX : e.clientY, from: size, last: size };
    setActive(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pos = axis === "x" ? e.clientX : e.clientY;
    d.last = d.from + (reverse ? pos - d.start : d.start - pos);
    onResize(d.last);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActive(false);
    onCommit(d.last);
  };

  const horizontal = axis === "x";
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      className={`group relative z-20 flex shrink-0 touch-none select-none items-center justify-center ${
        horizontal ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"
      } ${className}`}
    >
      <span
        className={`rounded-full transition-colors ${horizontal ? "h-10 w-[3px]" : "h-[3px] w-10"} ${
          active ? "bg-[#d8b25c]" : "bg-[#3a2f1e] group-hover:bg-[#8a6a2e]"
        }`}
      />
    </div>
  );
}
