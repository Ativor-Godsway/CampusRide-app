import { useWidth } from "./useWidth";
import { linePath, niceMax, ticks, yScale } from "./math";
import { ChartLegend, type Series } from "./PairedBars";

/** One or more lines over the same labels (requests vs driver-hours per hour). Each line can have its own axis top (`ownScale`). */
export function LineChart({ series, labels, summary, height = 200, showEvery = 2 }: { series: Series[]; labels: string[]; summary: string; height?: number; showEvery?: number }) {
  const [box, width] = useWidth<HTMLElement>();
  const plotH = height - 28;
  const left = 28;
  const plotW = width - left - 8;
  const top = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const y = yScale(top, plotH);
  const step = labels.length > 1 ? plotW / (labels.length - 1) : 0;
  const every = Math.max(showEvery, Math.ceil(44 / Math.max(1, step)));
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
        <g transform={`translate(${left} 0)`}>
          {series.map((s) => (
            <path key={s.label} d={linePath(s.values, plotW, plotH, top)} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) =>
            s.values.map((v, i) => (
              <circle key={`${s.label}${i}`} cx={i * step} cy={y(v)} r={3} fill={s.color}>
                <title>{`${labels[i]}: ${Math.round(v * 10) / 10} ${s.label.toLowerCase()}`}</title>
              </circle>
            )),
          )}
        </g>
        {labels.map((l, i) =>
          i % every === 0 ? (
            <text key={i} x={left + i * step} y={height - 8} textAnchor="middle" className="chart-axis">
              {l}
            </text>
          ) : null,
        )}
      </svg>
    </figure>
  );
}
