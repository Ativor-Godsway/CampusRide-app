import { useEffect, useMemo, useState } from "react";
import { ApiError, failureText, getFarPricing, getPlaces, saveFarPricing, type AdminPlace, type FarPricing } from "../api";
import { useToken } from "../auth";
import { cedis, cedisInput, parseCedis } from "../lib/money";
import { dayAndTime } from "../lib/time";

type FarPlace = FarPricing["farPlaces"][number];
type End = FarPlace["end"];
const END_LABEL: Record<End, string> = { NORTH: "North end", SOUTH: "South end (Diaspora)" };

/**
 * Far-trip pricing (server: services/ride/farePricing.ts). Campus has two
 * far ends, North and South. A Shared seat costs the far price only on a
 * trip from one end to the other; every other Shared trip pays the normal
 * price. Ride alone is the same everywhere. A price is set when a ride is
 * requested: saving here changes new requests only.
 */
export function FarPricingCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<FarPricing | null>(null);
  const [normal, setNormal] = useState("");
  const [far, setFar] = useState("");
  const [places, setPlaces] = useState<FarPlace[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminPlace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (f: FarPricing) => {
    setLoaded(f);
    setNormal(cedisInput(f.settings.sharedPesewas));
    setFar(cedisInput(f.settings.sharedFarPesewas));
    setPlaces(f.farPlaces);
  };

  useEffect(() => {
    getFarPricing(token).then(show, (err) => setError(failureText("Loading far-trip pricing", err)));
  }, [token]);

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

  const normalPesewas = parseCedis(normal);
  const farPesewas = parseCedis(far);
  const lone = loaded?.settings.loneFarePesewas ?? 1500;
  const valid = normalPesewas !== null && farPesewas !== null && normalPesewas >= 100 && farPesewas >= 100 && farPesewas <= lone;
  const chosen = useMemo(() => new Set(places.map((p) => p.id)), [places]);
  const changed =
    loaded !== null &&
    (normalPesewas !== loaded.settings.sharedPesewas ||
      farPesewas !== loaded.settings.sharedFarPesewas ||
      places.length !== loaded.farPlaces.length ||
      places.some((p) => !loaded.farPlaces.some((q) => q.id === p.id && q.end === p.end)));
  const setEnd = (id: string, end: End | "") =>
    setPlaces((all) => (end ? all.map((p) => (p.id === id ? { ...p, end } : p)) : all.filter((p) => p.id !== id)));
  const add = (r: AdminPlace, end: End) => {
    setPlaces((all) => [...all, { id: r.id, name: r.name, isActive: r.isActive, zoneName: r.zone.name, end }].sort((a, b) => a.name.localeCompare(b.name)));
    setQuery("");
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !loaded) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await saveFarPricing(token, { sharedPesewas: normalPesewas, sharedFarPesewas: farPesewas, farPlaces: places.map((p) => ({ id: p.id, end: p.end })) }));
      setNotice("Saved. New ride requests use it at once; rides already requested keep the price they were booked at.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving far-trip pricing", err) : "Saving far-trip pricing failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inset">
      <h3>Far-trip pricing</h3>
      <p className="muted">
        Campus has two far ends. A Shared seat costs the far price only when the trip goes from the north end to the south end, or back. Every other
        Shared trip pays the normal price: main campus to or from either end, inside one end, and main campus to main campus. Ride alone is {cedis(lone)}{" "}
        everywhere. A pin counts as the place it&apos;s at or near (within 250 m). The driver keeps 85% of whatever the rider pays.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <div className="filters">
            <label className="field">
              <span>Shared seat (GH₵)</span>
              <input inputMode="decimal" value={normal} onChange={(e) => setNormal(e.target.value)} required />
            </label>
            <label className="field">
              <span>Shared seat, far trip (GH₵)</span>
              <input inputMode="decimal" value={far} onChange={(e) => setFar(e.target.value)} required />
            </label>
          </div>
          {!valid ? <p className="error-text">Each price must be at least GH₵1, and a far seat can&apos;t cost more than Ride alone ({cedis(lone)}).</p> : null}

          {(["NORTH", "SOUTH"] as const).map((e) => {
            const mine = places.filter((p) => p.end === e);
            return (
              <div key={e}>
                <h4>
                  {END_LABEL[e]} ({mine.length})
                </h4>
                {mine.length === 0 ? <p className="muted small">No places yet: no trip pays the far price.</p> : null}
                <ul className="chip-list">
                  {mine.map((p) => (
                    <li key={p.id}>
                      <span>
                        {p.name} <span className="muted small">· {p.zoneName}{p.isActive ? "" : " · hidden from riders"}</span>
                      </span>{" "}
                      <select aria-label={`Far end for ${p.name}`} value={p.end} onChange={(ev) => setEnd(p.id, ev.target.value as End | "")}>
                        <option value="NORTH">North</option>
                        <option value="SOUTH">South</option>
                        <option value="">None</option>
                      </select>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <label className="field">
            <span>Add a place (annexes, &ldquo;other spot near&rdquo; places and places beside a hall count separately)</span>
            <input type="search" value={query} placeholder="Search places" onChange={(e) => setQuery(e.target.value)} />
          </label>
          {results.filter((r) => !chosen.has(r.id)).length > 0 ? (
            <ul className="chip-list">
              {results
                .filter((r) => !chosen.has(r.id))
                .map((r) => (
                  <li key={r.id}>
                    <span>
                      {r.name} <span className="muted small">· {r.zone.name}</span>
                    </span>{" "}
                    <button type="button" className="text-button" aria-label={`Add ${r.name} to the north end`} onClick={() => add(r, "NORTH")}>
                      North
                    </button>
                    <button type="button" className="text-button" aria-label={`Add ${r.name} to the south end`} onClick={() => add(r, "SOUTH")}>
                      South
                    </button>
                  </li>
                ))}
            </ul>
          ) : null}

          {loaded.settings.updatedAt ? (
            <p className="muted small">
              Last changed {dayAndTime(loaded.settings.updatedAt)}
              {loaded.settings.updatedBy ? ` by ${loaded.settings.updatedBy.name}` : ""}.
            </p>
          ) : (
            <p className="muted small">
              Prices not changed yet: the defaults ({cedis(loaded.defaults.sharedPesewas)} and {cedis(loaded.defaults.sharedFarPesewas)}).
            </p>
          )}
          <p>
            <button type="submit" className="tonal-button" disabled={busy || !valid || !changed}>
              {busy ? "Saving…" : "Save far-trip pricing"}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
