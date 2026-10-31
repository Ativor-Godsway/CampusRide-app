import type { ReactNode } from "react";

/**
 * A number with its label and one line under it (surface-2 tile, radius 20).
 * `value` null shows "—" with "Not enough data yet" — never a made-up 0%.
 * `dark`: the page's one dark hero block.
 */
export function StatTile({
  label,
  value,
  note,
  noteTone,
  dark = false,
  big = false,
}: {
  label: string;
  value: ReactNode | null;
  note?: ReactNode;
  noteTone?: "good" | "warn" | "bad";
  dark?: boolean;
  big?: boolean;
}) {
  const empty = value === null || value === undefined;
  return (
    <div className={`tile${dark ? " tile-dark" : ""}${big ? " tile-big" : ""}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value num" title={empty ? "Not enough data yet" : undefined}>
        {empty ? "—" : value}
      </span>
      {note ? <span className={`tile-note${noteTone ? ` note-${noteTone}` : ""}`}>{note}</span> : null}
    </div>
  );
}

export function TileRow({ children }: { children: ReactNode }) {
  return <div className="tiles">{children}</div>;
}
