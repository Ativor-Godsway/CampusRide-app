import { useEffect, useState } from "react";
import { useReduceMotion } from "./components/Illustration";

/**
 * Counts from 0 up to `target` over `durationMs` with an ease-out curve.
 * Great for money amounts on celebration screens. Jumps straight to the
 * final value when Reduce Motion is on.
 */
export function useCountUp(target: number, durationMs = 900): number {
  const reduceMotion = useReduceMotion();
  const [value, setValue] = useState(reduceMotion ? target : 0);

  useEffect(() => {
    if (reduceMotion) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduceMotion]);

  return value;
}
