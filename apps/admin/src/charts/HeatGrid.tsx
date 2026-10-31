import { heatLevel } from "./math";

const LEVEL_WORDS = ["None", "A few", "Some", "Many", "The most"] as const;

/**
 * Weekday × hour grid (Mon–Sun, the hours given). Five levels relative to
 * the busiest cell, each named in the legend ("None" … "The most") and in
 * every cell's tooltip with its exact count — colour is never the only cue.
 */
export function HeatGrid({
  values,
  hours,
  hourLabels,
  rowLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  what,
  summary,
}: {
  /** [day][hour 0–23] */
  values: number[][];
  hours: number[];
  hourLabels: string[];
  rowLabels?: string[];
  what: string;
  summary: string;
}) {
  const max = Math.max(0, ...values.flatMap((row) => hours.map((h) => row[h] ?? 0)));
  return (
    <figure className="heat">
      <div className="heat-legend" aria-hidden="true">
        <span>Fewer</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`heat-cell heat-${l}`} title={LEVEL_WORDS[l]} />
        ))}
        <span>More {what}</span>
      </div>
      <div className="heat-scroll">
        <table className="heat-grid" aria-label={summary}>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Day</span>
              </th>
              {hourLabels.map((l, i) => (
                <th key={i} scope="col">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((day, d) => (
              <tr key={day}>
                <th scope="row">{day}</th>
                {hours.map((h, i) => {
                  const v = values[d]?.[h] ?? 0;
                  const level = heatLevel(v, max);
                  return (
                    <td key={h} className={`heat-cell heat-${level}`} title={`${day} ${hourLabels[i]}: ${v} ${what} (${LEVEL_WORDS[level].toLowerCase()})`}>
                      <span className="sr-only">{v}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
