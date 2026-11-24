import { useEffect, useMemo, useState } from "react";
import { ApiError, failureText, getZoneNeighbours, saveZoneNeighbours, type ZoneNeighbours } from "../api";
import { useToken } from "../auth";

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const split = (k: string) => {
  const [a, b] = k.split("|") as [string, string];
  return { a, b };
};

/**
 * Zone neighbours (server: services/zones/zoneNeighbours.ts): a request is
 * offered to drivers in its pickup zone and the zones next to it. The
 * suggestion comes from where the zones are (areas that share a border, or
 * centres within 800 m). Every zone needs at least one neighbour.
 */
export function ZoneNeighboursCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<ZoneNeighbours | null>(null);
  const [pairs, setPairs] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (z: ZoneNeighbours) => {
    setLoaded(z);
    setPairs(new Set(z.pairs.map((p) => key(p.a, p.b))));
  };
  useEffect(() => {
    getZoneNeighbours(token).then(show, (err) => setError(failureText("Loading zone neighbours", err)));
  }, [token]);

  const names = useMemo(() => new Map((loaded?.zones ?? []).map((z) => [z.id, z.name])), [loaded]);
  const suggested = useMemo(() => new Set((loaded?.suggested ?? []).map((p) => key(p.a, p.b))), [loaded]);
  const distance = useMemo(() => new Map((loaded?.suggested ?? []).map((p) => [key(p.a, p.b), p.centreMeters])), [loaded]);
  if (!loaded) {
    return (
      <div className="inset">
        <h3>Zone neighbours</h3>
        {error ? <p className="error-text" role="alert">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const n = loaded.zones.length;
  const saved = new Set(loaded.pairs.map((p) => key(p.a, p.b)));
  const fullMesh = n > 1 && saved.size === (n * (n - 1)) / 2;
  const changed = pairs.size !== saved.size || [...pairs].some((k) => !saved.has(k));
  const isSuggested = pairs.size === suggested.size && [...pairs].every((k) => suggested.has(k));
  const lonely = loaded.zones.filter((z) => ![...pairs].some((k) => k.split("|").includes(z.id)));
  const neighboursOf = (id: string) =>
    [...pairs]
      .map(split)
      .filter((p) => p.a === id || p.b === id)
      .map((p) => (p.a === id ? p.b : p.a))
      .sort((x, y) => (names.get(x) ?? "").localeCompare(names.get(y) ?? ""));
  const toggle = (a: string, b: string, on: boolean) =>
    setPairs((all) => {
      const next = new Set(all);
      if (on) next.add(key(a, b));
      else next.delete(key(a, b));
      return next;
    });

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await saveZoneNeighbours(token, [...pairs].map(split)));
      setNotice("Saved. New requests are offered by these neighbours within a minute.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving zone neighbours", err) : "Saving zone neighbours failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inset">
      <h3>Zone neighbours</h3>
      <p className="muted">
        A request is offered to drivers in its pickup zone and in the zones next to it (Shared cars already on a trip are checked separately, by detour).
        Suggested: zones whose areas share a border, or whose centres are within 800 m.
      </p>
      {fullMesh ? (
        <p className="warn-text">Every zone is next to every other right now (the old setup): every request goes to every online driver on campus.</p>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      <p className="muted small">
        {pairs.size} pairs{isSuggested ? " — the suggested ones" : ` (${suggested.size} suggested)`}.
        {lonely.length ? ` No neighbour yet: ${lonely.map((z) => z.name).join(", ")}.` : ""}
      </p>
      <div className="table-scroll">
      <table className="data-table neighbour-table">
        <thead>
          <tr>
            <th scope="col">Zone</th>
            <th scope="col">Next to</th>
          </tr>
        </thead>
        <tbody>
          {loaded.zones.map((z) => {
            const mine = neighboursOf(z.id);
            const others = loaded.zones.filter((o) => o.id !== z.id && !mine.includes(o.id));
            return (
              <tr key={z.id}>
                <th scope="row">{z.name}</th>
                <td>
                  <ul className="chip-list">
                    {mine.map((o) => (
                      <li key={o}>
                        <span title={distance.has(key(z.id, o)) ? `${distance.get(key(z.id, o))} m apart (suggested)` : "Not suggested"}>
                          {names.get(o)}
                          {suggested.has(key(z.id, o)) ? "" : " *"}
                        </span>{" "}
                        <button type="button" className="text-button" aria-label={`${z.name} is not next to ${names.get(o)}`} onClick={() => toggle(z.id, o, false)}>
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                  {others.length ? (
                    <select aria-label={`Add a neighbour for ${z.name}`} value="" onChange={(e) => e.target.value && toggle(z.id, e.target.value, true)}>
                      <option value="">Add a neighbour…</option>
                      {others.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                          {suggested.has(key(z.id, o.id)) ? " (suggested)" : ""}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <p className="muted small">* not in the suggestion (chosen by hand).</p>
      <p>
        <button type="button" className="text-button" disabled={busy || isSuggested} onClick={() => setPairs(new Set(suggested))}>
          Use the suggested neighbours
        </button>{" "}
        <button type="button" className="tonal-button" disabled={busy || !changed || lonely.length > 0} onClick={() => void save()}>
          {busy ? "Saving…" : "Save zone neighbours"}
        </button>
      </p>
    </div>
  );
}
