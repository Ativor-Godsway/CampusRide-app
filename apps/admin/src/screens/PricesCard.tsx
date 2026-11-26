import { useEffect, useState } from "react";
import { farePricesProblem, sharedFare, type FarePrices } from "@rida/shared";
import { ApiError, failureText, getFarPricing, priceSettingsOf, saveFarPricing, type FarPricing } from "../api";
import { useToken } from "../auth";
import { cedis, cedisInput, parseCedis } from "../lib/money";
import { dayAndTime } from "../lib/time";

const FIELDS: Array<{ key: keyof FarePrices; label: string }> = [
  { key: "sharedPesewas", label: "Shared, 1 seat (GH₵)" },
  { key: "shared2Pesewas", label: "Shared, 2 seats (GH₵)" },
  { key: "shared3Pesewas", label: "Shared, 3 seats (GH₵)" },
  { key: "farPerSeatPesewas", label: "Far trip, added per seat (GH₵)" },
  { key: "lonePesewas", label: "Ride alone, whole car (GH₵)" },
];

/**
 * The prices (server: services/ride/farePricing.ts, 2026-11-26). Shared is
 * priced by the seats in one booking (a rider bringing up to two friends);
 * a trip between the north and south ends adds the far surcharge for each
 * seat; Ride alone is one price for the whole car, 1–4 people. A price is
 * set when a ride is requested: saving changes new requests only. The far
 * ends' places are on the Places page. Audit-logged.
 */
export function PricesCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<FarPricing | null>(null);
  const [inputs, setInputs] = useState<Record<keyof FarePrices, string>>({
    sharedPesewas: "",
    shared2Pesewas: "",
    shared3Pesewas: "",
    farPerSeatPesewas: "",
    lonePesewas: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (f: FarPricing) => {
    setLoaded(f);
    const p = priceSettingsOf(f);
    setInputs({
      sharedPesewas: cedisInput(p.sharedPesewas),
      shared2Pesewas: cedisInput(p.shared2Pesewas),
      shared3Pesewas: cedisInput(p.shared3Pesewas),
      farPerSeatPesewas: cedisInput(p.farPerSeatPesewas),
      lonePesewas: cedisInput(p.lonePesewas),
    });
  };
  useEffect(() => {
    getFarPricing(token).then(show, (err) => setError(failureText("Loading the prices", err)));
  }, [token]);

  const values: FarePrices = {
    sharedPesewas: parseCedis(inputs.sharedPesewas) ?? NaN,
    shared2Pesewas: parseCedis(inputs.shared2Pesewas) ?? NaN,
    shared3Pesewas: parseCedis(inputs.shared3Pesewas) ?? NaN,
    farPerSeatPesewas: parseCedis(inputs.farPerSeatPesewas) ?? NaN,
    lonePesewas: parseCedis(inputs.lonePesewas) ?? NaN,
  };
  const problem = farePricesProblem(values);
  const saved = loaded ? priceSettingsOf(loaded) : null;
  const unchanged = saved !== null && FIELDS.every(({ key }) => values[key] === saved[key]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (problem || !loaded) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The far-end places go back exactly as they are (they're set on the Places page).
      show(await saveFarPricing(token, { ...values, farPlaces: loaded.farPlaces.map((p) => ({ id: p.id, end: p.end })) }));
      setNotice("Saved. New ride requests use these prices at once; rides already requested keep the price they were booked at.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving the prices", err) : "Saving the prices failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inset">
      <h3>Prices</h3>
      <p className="muted">
        A rider can book Shared for up to 3 people (themself and two friends): one booking, one price, and it takes that many of the car&apos;s 4 seats.
        On a trip between the north and south ends, the far surcharge is added for each seat. Ride alone is one price for the whole car, up to 4 people.
        The wait fee is per booking. The driver keeps 85% of whatever the rider pays.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <div className="filters">
            {FIELDS.map(({ key, label }) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  inputMode="decimal"
                  value={inputs[key]}
                  onChange={(e) => setInputs((all) => ({ ...all, [key]: e.target.value }))}
                  required
                />
              </label>
            ))}
          </div>
          {problem ? (
            <p className="error-text">{problem}</p>
          ) : (
            <table className="data-table" aria-label="What riders pay">
              <thead>
                <tr>
                  <th scope="col">Shared</th>
                  <th scope="col">1 seat</th>
                  <th scope="col">2 seats</th>
                  <th scope="col">3 seats</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Normal trip</th>
                  {[1, 2, 3].map((n) => (
                    <td key={n}>{cedis(sharedFare(n, false, values))}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">North ↔ South</th>
                  {[1, 2, 3].map((n) => (
                    <td key={n}>{cedis(sharedFare(n, true, values))}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          )}
          <p className="muted small">
            {loaded.settings.updatedAt
              ? `Last changed ${dayAndTime(loaded.settings.updatedAt)}${loaded.settings.updatedBy ? ` by ${loaded.settings.updatedBy.name}` : ""}.`
              : `Not changed yet: the defaults, Shared ${cedis(loaded.defaults.sharedPesewas)} / ${cedis(loaded.defaults.shared2Pesewas)} / ${cedis(
                  loaded.defaults.shared3Pesewas,
                )}, +${cedis(loaded.defaults.farPerSeatPesewas)} a seat far, Ride alone ${cedis(loaded.defaults.lonePesewas)}.`}
          </p>
          <p>
            <button type="submit" className="tonal-button" disabled={busy || !!problem || unchanged}>
              {busy ? "Saving…" : "Save prices"}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
