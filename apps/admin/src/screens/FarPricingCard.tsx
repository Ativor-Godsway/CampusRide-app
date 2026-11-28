import { useEffect, useMemo, useState } from "react";
import { ApiError, failureText, getFarPricing, getPlaces, priceSettingsOf, saveFarPricing, type AdminPlace, type FarPricing } from "../api";
import { useToken } from "../auth";
import { cedis } from "../lib/money";
import { dayAndTime } from "../lib/time";

type FarPlace = FarPricing["farPlaces"][number];
type End = FarPlace["end"];
const END_LABEL: Record<End, string> = { NORTH: "North end", SOUTH: "South end (Diaspora)" };

/**
 * Far-trip places (server: services/ride/farePricing.ts). Campus has two far
 * ends, North and South. A Shared booking pays the far surcharge (per seat,
 * set with the other prices in Settings → Prices) only on a trip from one
 * end to the other. Saving here changes new requests only.
 */
export function FarPricingCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<FarPricing | null>(null);
  const [places, setPlaces] = useState<FarPlace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (f: FarPricing) => {
    setLoaded(f);
    setPlaces(f.farPlaces);
  };

  useEffect(() => {
    getFarPricing(token).then(show, (err) => setError(failureText("Loading far-trip places", err)));
  }, [token]);


  const chosen = useMemo(() => new Set(places.map((p) => p.id)), [places]);
  const changed =
    loaded !== null &&
    (places.length !== loaded.farPlaces.length ||
      places.some((p) => !loaded.farPlaces.some((q) => q.id === p.id && q.end === p.end)));
  const setEnd = (id: string, end: End | "") =>
    setPlaces((all) => (end ? all.map((p) => (p.id === id ? { ...p, end } : p)) : all.filter((p) => p.id !== id)));
  const add = (r: AdminPlace, end: End) => {
    setPlaces((all) => [...all, { id: r.id, name: r.name, isActive: r.isActive, zoneName: r.zone.name, end }].sort((a, b) => a.name.localeCompare(b.name)));
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!loaded) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The prices go back exactly as they are (they're set in Settings → Prices).
      show(await saveFarPricing(token, { ...priceSettingsOf(loaded), farPlaces: places.map((p) => ({ id: p.id, end: p.end })) }));
      setNotice("Saved. New ride requests use it at once; rides already requested keep the price they were booked at.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving far-trip places", err) : "Saving far-trip places failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="section-help">
        Campus has two far ends. A Shared booking pays the far surcharge
        {loaded ? ` (${cedis(loaded.settings.farPerSeatPesewas)} a seat)` : ""} only on a trip from one end to the other. Every other trip pays the normal price.
        A pin counts as the place it&apos;s at or near (within 250 m). Annexes and places beside a hall count separately.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="saved-note">✓ {notice}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="stack" onSubmit={(e) => void save(e)}>
          <div className="far-columns">
            {(["NORTH", "SOUTH"] as const).map((end) => (
              <EndColumn key={end} end={end} places={places.filter((p) => p.end === end)} chosen={chosen} onRemove={(id) => setEnd(id, "")} onAdd={(r) => add(r, end)} />
            ))}
          </div>
          <div className="row-between">
            <span className="section-meta">
              {loaded.settings.updatedAt
                ? `Last changed by ${loaded.settings.updatedBy?.name ?? "an admin"} · ${dayAndTime(loaded.settings.updatedAt)}`
                : "Not changed yet"}
            </span>
            <button type="submit" className="primary-button" disabled={busy || !changed}>
              {busy ? "Saving…" : "Save far-trip places"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** One far end: its places as chips (× removes), and a search to add one. */
function EndColumn({ end, places, chosen, onRemove, onAdd }: { end: End; places: FarPlace[]; chosen: Set<string>; onRemove: (id: string) => void; onAdd: (p: AdminPlace) => void }) {
  const token = useToken();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminPlace[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      getPlaces(token, q).then(
        (r) => setResults(r.places.slice(0, 8)),
        () => setResults([]),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [query, token]);
  const open = results.filter((r) => !chosen.has(r.id));
  return (
    <div className="far-column">
      <h3>
        {END_LABEL[end]} <span className="muted num">{places.length}</span>
      </h3>
      {places.length === 0 ? (
        <p className="muted small">No places yet: no trip pays the far price.</p>
      ) : (
        <div className="chip-list">
          {places.map((p) => (
            <span key={p.id} className="place-chip" title={`${p.zoneName}${p.isActive ? "" : " · hidden from riders"}`}>
              {p.name}
              <button type="button" aria-label={`Remove ${p.name} from the ${END_LABEL[end].toLowerCase()}`} onClick={() => onRemove(p.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="place-search">
        <input type="search" value={query} placeholder="Add place…" aria-label={`Add a place to the ${END_LABEL[end].toLowerCase()}`} onChange={(e) => setQuery(e.target.value)} />
        {open.length > 0 ? (
          <ul className="place-results">
            {open.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    onAdd(r);
                    setQuery("");
                  }}
                >
                  {r.name} <span className="muted small">· {r.zone.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
