import type { Projection } from "./geo";

/** A car seen from above: green while waiting, dark on a trip; the arrow points where it was heading. */
export function CarMarker({ p, k, latitude, longitude, heading, onTrip, label, stale = false, onClick }: { p: Projection; k: number; latitude: number; longitude: number; heading: number | null; onTrip: boolean; label: string; stale?: boolean; onClick?: () => void }) {
  const [x, y] = p.project(latitude, longitude);
  return (
    <g
      transform={`translate(${x} ${y}) scale(${1 / k})`}
      className={`map-car${onTrip ? " on-trip" : ""}${stale ? " stale" : ""}${onClick ? " clickable" : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={label}
      onClick={onClick}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
    >
      <title>{label}</title>
      <circle r={13} className="car-body" />
      <path d="M0 -7 L5.5 4 L0 1.5 L-5.5 4 Z" className="car-arrow" transform={`rotate(${heading ?? 0})`} />
    </g>
  );
}

/** A rider waiting for a driver: an amber pulse. */
export function WaitingMarker({ p, k, latitude, longitude, label, onClick }: { p: Projection; k: number; latitude: number; longitude: number; label: string; onClick?: () => void }) {
  const [x, y] = p.project(latitude, longitude);
  return (
    <g transform={`translate(${x} ${y}) scale(${1 / k})`} className={`map-waiting${onClick ? " clickable" : ""}`} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} aria-label={label} onClick={onClick} onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}>
      <title>{label}</title>
      <circle r={22} className="pulse" />
      <circle r={9} className="dot" />
    </g>
  );
}

/** A pickup (green ring) or drop-off (dark square) stop. */
export function StopMarker({ p, k, latitude, longitude, kind, label }: { p: Projection; k: number; latitude: number; longitude: number; kind: "pickup" | "dropoff"; label: string }) {
  const [x, y] = p.project(latitude, longitude);
  return (
    <g transform={`translate(${x} ${y}) scale(${1 / k})`} className={`map-stop ${kind}`}>
      <title>{label}</title>
      {kind === "pickup" ? <circle r={7} /> : <rect x={-6} y={-6} width={12} height={12} rx={2} />}
    </g>
  );
}

/** A line through points (a trip's route, a driver's trail). */
export function RouteLine({ p, points, className = "map-route" }: { p: Projection; points: Array<{ latitude: number; longitude: number }>; className?: string }) {
  if (points.length < 2) return null;
  const d = points.map((pt, i) => {
    const [x, y] = p.project(pt.latitude, pt.longitude);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return <path d={d.join(" ")} className={className} vectorEffect="non-scaling-stroke" />;
}
