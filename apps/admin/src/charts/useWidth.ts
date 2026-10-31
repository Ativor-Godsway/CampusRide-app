import { useEffect, useRef, useState } from "react";

/**
 * The width of a chart's box in screen pixels, kept current as it resizes,
 * so the SVG is drawn at its real size and its text stays 11–13 px instead
 * of growing and shrinking with the page. `fallback` until measured (and on
 * the server, in tests).
 */
export function useWidth<T extends HTMLElement>(fallback = 680) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
