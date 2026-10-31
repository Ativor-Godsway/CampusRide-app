import { useWidth } from "./useWidth";
import { barSlots, niceMax, ticks, yScale } from "./math";

export interface Series {
  label: string;
  /** A design-system colour token (CSS var), e.g. "var(--green-500)". */
  color: string;
  values: number[];
}

/**
 * Bars side by side per group (requests vs drivers online, per hour). A
 * legend names each colour; the SVG carries a text summary for screen
 * readers, and every bar a <title> with its number.
 */
export function PairedBars({
  series,
  labels,
  summary,
  height = 200,
  showEvery = 1,
}: {
  series: Series[];
  labels: string[];
  summary: string;
  height?: number;
  showEvery?: number;
}) {
  const [box, width] = useWidth<HTMLElement>();
  const plotH = height - 28;
  const left = 28;
  const plotW = width - left;
  const top = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const y = yScale(top, plotH);
  const slots = barSlots(labels.length, series.length, plotW, 0.28);
  // Fewer axis labels when they'd touch (a phone): about 30 px each.
  const every = Math.max(showEvery, Math.ceil(30 / Math.max(1, plotW / Math.max(1, labels.length))));
  return (
    <figure className="chart" ref={box}>
      <ChartLegend series={series} />
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={summary} className="chart-svg">
        {ticks(top, 2).map((t) => (
          <g key={t}>
            <line x1={left} x2={width} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={left - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">
              {t}
            </text>
          </g>
        ))}
        {slots.map((slot, i) => (
          <g key={i}>
            {series.map((s, j) => {
              const v = s.values[i] ?? 0;
              return (
                <rect key={s.label} x={left + slot.x + j * slot.barWidth} y={y(v)} width={Math.max(1, slot.barWidth - 2)} height={plotH - y(v)} rx={3} fill={s.color}>
                  <title>{`${labels[i]}: ${v} ${s.label.toLowerCase()}`}</title>
                </rect>
              );
            })}
            {i % every === 0 ? (
              <text x={left + slot.centre} y={height - 8} textAnchor="middle" className="chart-axis">
                {labels[i]}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function ChartLegend({ series }: { series: Array<{ label: string; color: string; dashed?: boolean }> }) {
  return (
    <figcaption className="legend">
      {series.map((s) => (
        <span key={s.label} className="legend-item">
          <span className={`legend-swatch${s.dashed ? " dashed" : ""}`} style={{ background: s.dashed ? "transparent" : s.color, borderColor: s.color }} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </figcaption>
  );
}
