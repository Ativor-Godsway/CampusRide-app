import { niceMax } from "./math";

/** Horizontal bars with their label and count (cancellation reasons, who cancelled). */
export function BarList({ items, color = "var(--green-500)", summary }: { items: Array<{ label: string; value: number; color?: string }>; color?: string; summary: string }) {
  const top = niceMax(Math.max(0, ...items.map((i) => i.value)));
  return (
    <ul className="bar-list" aria-label={summary}>
      {items.map((item) => (
        <li key={item.label}>
          <span className="bar-label">{item.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${(item.value / top) * 100}%`, background: item.color ?? color }} />
          </span>
          <span className="bar-value num">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** One bar split into parts (before / after a driver took it), each part labelled. */
export function StackedBar({ parts, summary }: { parts: Array<{ label: string; value: number; color: string }>; summary: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="stacked" role="img" aria-label={summary}>
      <div className="stacked-bar">
        {parts.map((p) =>
          p.value > 0 ? <span key={p.label} style={{ width: `${(p.value / Math.max(1, total)) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} /> : null,
        )}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.label} className="legend-item">
            <span className="legend-swatch" style={{ background: p.color }} aria-hidden="true" />
            {p.label} <strong className="num">{p.value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}
