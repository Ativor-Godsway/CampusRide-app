import { useEffect, useRef, useState } from "react";
import { useReduceMotion } from "./components/Illustration";

/**
 * A number that glides from what it showed to `target` when `target`
 * changes (ease-out, `durationMs`) — a price updating as a stepper changes,
 * say. Shows `target` straight away the first time, whenever `jumpKey`
 * changes (new prices from the server: they simply appear), and always with
 * Reduce Motion on. Whole numbers only (pesewas).
 */
export function useTweenNumber(target: number, durationMs = 280, jumpKey?: string | number): number {
  const reduceMotion = useReduceMotion();
  const [value, setValue] = useState(target);
  const shown = useRef(target);
  shown.current = value;
  const lastJumpKey = useRef(jumpKey);

  useEffect(() => {
    const from = shown.current;
    const jump = lastJumpKey.current !== jumpKey;
    lastJumpKey.current = jumpKey;
    if (jump || reduceMotion || from === target || !Number.isFinite(from) || !Number.isFinite(target)) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduceMotion, jumpKey]);

  return value;
}
