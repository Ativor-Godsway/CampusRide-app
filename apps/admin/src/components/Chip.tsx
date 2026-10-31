import type { ReactNode } from "react";

export type ChipTone = "green" | "amber" | "red" | "neutral" | "dark";

/** A status chip. Always a word (never colour alone); the tone only reinforces it. */
export function Chip({ tone = "neutral", children, title }: { tone?: ChipTone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}
