import { useEffect, useState } from "react";
import { farePricesProblem, sharedFare, type FarePrices } from "@rida/shared";
import { ApiError, failureText, getFarPricing, priceSettingsOf, saveFarPricing, type FarPricing } from "../api";
import { useToken } from "../auth";
import { cedis, cedisInput, parseCedis } from "../lib/money";
import { dayAndTime } from "../lib/time";

const FIELDS: Array<{ key: keyof FarePrices }> = [{ key: "sharedPesewas" }, { key: "shared2Pesewas" }, { key: "shared3Pesewas" }, { key: "farPerSeatPesewas" }, { key: "lonePesewas" }];

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

  const ok = !problem;
  const example = (n: number, far: boolean) => (ok ? cedis(sharedFare(n, far, values)) : "—");
  const ITEMS: Array<{ key: keyof FarePrices; title: string; help: string; example: string }> = [
    { key: "sharedPesewas", title: "Shared, 1 seat", help: "One rider sharing the car with others going the same way.", example: `Night Market → Balme Library, 1 seat = ${example(1, false)}` },
    { key: "shared2Pesewas", title: "Shared, 2 seats", help: "One booking for the rider and a friend: one price, two of the 4 seats.", example: `Night Market → Balme Library, 2 seats = ${example(2, false)}` },
    { key: "shared3Pesewas", title: "Shared, 3 seats", help: "The rider and two friends in one booking.", example: `Night Market → Balme Library, 3 seats = ${example(3, false)}` },
    { key: "farPerSeatPesewas", title: "Far trip, per seat", help: "Added for each seat when a Shared trip goes between the north and south ends.", example: `Pentagon → Jean Nelson, 2 seats = ${example(2, true)}` },
    { key: "lonePesewas", title: "Ride alone", help: "The whole car, up to 4 people, the same price anywhere on campus.", example: `Any trip, 1–4 people = ${ok ? cedis(values.lonePesewas) : "—"}` },
  ];

  return (
    <div className="stack">
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="saved-note">✓ {notice}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="stack" onSubmit={(e) => void save(e)}>
          <div className="price-grid">
            {ITEMS.map(({ key, title, help, example: ex }) => (
              <label className="price-item" key={key}>
                <strong>{title}</strong>
                <span className="price-input">
                  GH₵
                  <input inputMode="decimal" value={inputs[key]} onChange={(e) => setInputs((all) => ({ ...all, [key]: e.target.value }))} required aria-label={`${title} (GH₵)`} />
                </span>
                <p>{help}</p>
                <span className="example">{ex}</span>
              </label>
            ))}
          </div>
          {problem ? <p className="error-text">{problem}</p> : null}
          <div className="row-between">
            <span className="section-meta">
              {loaded.settings.updatedAt
                ? `Last changed by ${loaded.settings.updatedBy?.name ?? "an admin"} · ${dayAndTime(loaded.settings.updatedAt)}`
                : `Not changed yet: the defaults.`}{" "}
              New requests use a change at once; rides already requested keep their price.
            </span>
            <button type="submit" className="primary-button" disabled={busy || !!problem || unchanged}>
              {busy ? "Saving…" : "Save prices"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
