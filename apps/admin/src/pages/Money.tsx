import { useEffect, useState } from "react";
import {
  ApiError,
  failureText,
  getCommissionTerms,
  getDrivers,
  getPayouts,
  recordTopUp,
  removeTopUp,
  saveCommissionTerms,
  type CommissionTerms,
  type Payouts,
  type TopUp,
} from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CsvButton } from "../components/CsvButton";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { StatTile } from "../components/StatTile";
import { Loaded } from "../components/States";
import { useToast } from "../components/Toast";
import { cedis, count, parseCedis } from "../lib/money";
import { periodLabel, periodQuery } from "../lib/period";
import { Link, useRouter, withParams } from "../lib/router";
import { dayAndTime, humanDay, isoDay } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { useInvestorView } from "../lib/useInvestorView";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";
import { CashOwedPage } from "./CashOwed";

type Tab = "income" | "topups" | "commission";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "income", label: "Driver income" },
  { value: "topups", label: "Top-ups" },
  { value: "commission", label: "Commission" },
];

const METHOD_LABEL: Record<TopUp["method"], string> = { MOMO: "MoMo", CASH: "Cash" };

/** "15%", "12.5%". */
export function ratePercent(bps: number): string {
  return `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2).replace(/0$/, "")}%`;
}

/** "12.5" → 1250 basis points; null when it isn't a rate from 0 to 50. */
export function parseRate(input: string): number | null {
  const t = input.trim().replace(/%$/, "");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= 0 && bps <= 5000 ? bps : null;
}

/** The commission rate and the waiver: what drivers owe on each completed fare, and when they owe nothing. */
export function CommissionTermsCard({ readOnly = false }: { readOnly?: boolean }) {
  const token = useToken();
  const toast = useToast();
  const [loaded, setLoaded] = useState<CommissionTerms | null>(null);
  const [rate, setRate] = useState("15");
  const [waived, setWaived] = useState(false);
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = (t: CommissionTerms) => {
    setLoaded(t);
    setRate(ratePercent(t.terms.rateBps).replace("%", ""));
    setWaived(t.terms.waived);
    setFrom(t.terms.waivedFromDay ?? t.launchDay);
  };
  useEffect(() => {
    getCommissionTerms(token).then(show, (err) => setError(failureText("Loading the commission settings", err)));
  }, [token]);

  const bps = parseRate(rate);
  const today = isoDay(Date.now());
  const fromOk = !waived || (/^\d{4}-\d{2}-\d{2}$/.test(from) && from <= today);
  const changedTerms =
    loaded !== null && (bps !== loaded.terms.rateBps || waived !== loaded.terms.waived || (waived && from !== (loaded.terms.waivedFromDay ?? "")));

  async function save() {
    if (bps === null || !fromOk) return;
    setBusy(true);
    setError(null);
    try {
      show(await saveCommissionTerms(token, { rateBps: bps, waived, waivedFromDay: waived ? from : null }));
      setConfirming(false);
      toast(waived ? `Commission waived from ${humanDay(from)}` : `Commission on: ${ratePercent(bps)} of each completed fare`);
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving the commission settings", err) : "Saving failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Commission rate and waiver">
      <p className="card-sub">
        CampusRide&apos;s share of each completed fare, worked out automatically when the trip ends. Nobody types it in.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <fieldset className="read-only" disabled={readOnly}>
          <div className="filters">
            <label className="field">
              <span>Commission rate (%)</span>
              <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-invalid={bps === null} />
            </label>
          </div>
          {bps === null ? <p className="error-text">A rate from 0% to 50%.</p> : null}
          <div className="switch-row" style={{ marginTop: 12 }}>
            <button type="button" role="switch" aria-checked={waived} aria-label="Commission waived" className="big-switch" onClick={() => setWaived((w) => !w)} />
            <span>
              <strong>Commission waived {waived ? "ON" : "OFF"}</strong>
              <span className="muted small">
                {waived
                  ? "Drivers owe nothing on trips completed from the start date, and the driver app shows nothing owed (no balance, no Pay button, nobody blocked)."
                  : `Every completed fare is charged ${bps === null ? "the rate" : ratePercent(bps)} automatically. Drivers see what they owe in the app.`}
              </span>
            </span>
          </div>
          {waived ? (
            <div className="filters" style={{ marginTop: 12 }}>
              <label className="field">
                <span>Waived from</span>
                <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
              </label>
            </div>
          ) : null}
          {!fromOk ? <p className="error-text">Choose today or an earlier day.</p> : null}
          <div className="section-meta" style={{ marginTop: 12 }}>
            <span>
              Waived so far: <strong className="num">{cedis(loaded.totals.waivedPesewas)}</strong> on {count(loaded.totals.waivedTrips)} trips
            </span>
            <span>·</span>
            <span>
              Charged: <strong className="num">{cedis(loaded.totals.chargedPesewas)}</strong> on {count(loaded.totals.chargedTrips)} trips
            </span>
            <span>·</span>
            <span>
              {loaded.terms.updatedAt
                ? `Last changed by ${loaded.terms.updatedBy?.name ?? "an admin"} ${dayAndTime(loaded.terms.updatedAt)}`
                : "Not changed yet: 15%, not waived"}
            </span>
          </div>
          {readOnly ? null : (
            <p>
              <button type="button" className="primary-button" disabled={!changedTerms || bps === null || !fromOk || busy} onClick={() => setConfirming(true)}>
                Save commission
              </button>
            </p>
          )}
        </fieldset>
      )}
      {confirming && loaded && bps !== null ? (
        <ConfirmDialog
          title={waived ? "Waive commission?" : "Charge commission?"}
          confirmLabel={waived ? "Waive commission" : `Charge ${ratePercent(bps)}`}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void save()}
        >
          {waived ? (
            <p>
              Trips completed from <strong>{humanDay(from)}</strong> will owe nothing, including ones already completed. Drivers will see nothing owed in the
              app. Commission is still recorded for your reports as &ldquo;waived&rdquo;.
            </p>
          ) : (
            <p>
              From now on every completed fare is charged <strong>{ratePercent(bps)}</strong>, automatically. Trips completed while commission was waived stay
              waived. Drivers will see what they owe in the app.
            </p>
          )}
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}

/** The form for a top-up paid to a driver. */
function RecordTopUp({ onDone }: { onDone: () => void }) {
  const token = useToken();
  const toast = useToast();
  const drivers = usePolled(() => getDrivers(token, `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`), "topup-drivers");
  const [driverId, setDriverId] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(isoDay(Date.now()));
  const [method, setMethod] = useState<"MOMO" | "CASH">("MOMO");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pesewas = parseCedis(amount);
  const driverName = drivers.data?.drivers.find((d) => d.driverId === driverId)?.name ?? "";
  const valid = Boolean(driverId) && pesewas !== null && pesewas > 0 && day <= isoDay(Date.now());

  async function save() {
    if (!valid || pesewas === null) return;
    setBusy(true);
    setError(null);
    try {
      await recordTopUp(token, { driverId, amountPesewas: pesewas, paidOn: day, method, note: note.trim() || null });
      toast(`Top-up of ${cedis(pesewas)} recorded for ${driverName}`);
      setAmount("");
      setNote("");
      setConfirming(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Recording the top-up", err) : "Recording failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Record a top-up">
      <p className="card-sub">Money CampusRide paid a driver on top of their fares (the launch guarantee).</p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setConfirming(true);
        }}
      >
        <label className="field">
          <span>Driver</span>
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)} required>
            <option value="">Choose a driver…</option>
            {(drivers.data?.drivers ?? [])
              .filter((d) => d.isApproved)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((d) => (
                <option key={d.driverId} value={d.driverId}>
                  {d.name}
                  {d.plate ? ` · ${d.plate}` : ""}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Amount (GH₵)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 150" required />
        </label>
        <label className="field">
          <span>For the day</span>
          <input type="date" value={day} max={isoDay(Date.now())} onChange={(e) => setDay(e.target.value)} required />
        </label>
        <label className="field">
          <span>Paid by</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as "MOMO" | "CASH")}>
            <option value="MOMO">MoMo</option>
            <option value="CASH">Cash</option>
          </select>
        </label>
        <label className="field" style={{ maxWidth: 320 }}>
          <span>Note (optional)</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Guarantee for Monday" />
        </label>
        <button type="submit" className="primary-button" disabled={!valid}>
          Record top-up
        </button>
      </form>
      {amount && pesewas === null ? <p className="error-text">Enter an amount like 150 or 75.50.</p> : null}
      {confirming && pesewas !== null ? (
        <ConfirmDialog
          title="Record this top-up?"
          confirmLabel="Record top-up"
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void save()}
        >
          <p>
            <strong>{cedis(pesewas)}</strong> by {METHOD_LABEL[method]} to <strong>{driverName}</strong> for {humanDay(day)}.
          </p>
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}

function IncomeTab({ p }: { p: Payouts }) {
  const { path, search, navigate } = useRouter();
  return (
    <>
      <div className="kpi-hero">
        <StatTile dark label="Total driver income" value={cedis(p.totals.incomePesewas)} note="Fares − commission due + top-ups" />
        <StatTile label="Fares" value={cedis(p.totals.faresPesewas)} note={`${count(p.totals.trips)} trips`} />
        <StatTile label="Top-ups paid" value={cedis(p.totals.topUpsPesewas)} note={`${count(p.totals.topUpCount)} top-ups`} />
        <StatTile label="Commission due" value={cedis(p.totals.commissionDuePesewas)} note={p.totals.commissionDuePesewas === 0 ? "Nothing owed (waived or no trips)" : "Owed to CampusRide"} />
      </div>
      <Section
        title="Per driver"
        actions={
          <CsvButton
            filename="driver-income-per-driver.csv"
            header={["Driver", "Plate", "Trips", "Riders", "Fares GHS", "Commission due GHS", "Top-ups GHS", "Total income GHS"]}
            rows={() => p.perDriver.map((r) => [r.name, r.plate ?? "", r.trips, r.riders, r.faresPesewas / 100, r.commissionDuePesewas / 100, r.topUpsPesewas / 100, r.incomePesewas / 100])}
          />
        }
      >
        <DataTable
          columns={[
            { key: "driver", header: "Driver", render: (r) => <strong>{r.name}</strong>, sortValue: (r) => r.name },
            { key: "trips", header: "Trips", render: (r) => <span className="num">{r.trips}</span>, sortValue: (r) => r.trips, align: "right" },
            { key: "riders", header: "Riders", render: (r) => <span className="num">{r.riders}</span>, sortValue: (r) => r.riders, align: "right" },
            { key: "fares", header: "Fares", render: (r) => <span className="num">{cedis(r.faresPesewas)}</span>, sortValue: (r) => r.faresPesewas, align: "right" },
            { key: "comm", header: "Commission due", render: (r) => <span className="num">{cedis(r.commissionDuePesewas)}</span>, sortValue: (r) => r.commissionDuePesewas, align: "right" },
            { key: "topups", header: "Top-ups", render: (r) => <span className="num">{cedis(r.topUpsPesewas)}</span>, sortValue: (r) => r.topUpsPesewas, align: "right" },
            { key: "income", header: "Total income", render: (r) => <strong className="num">{cedis(r.incomePesewas)}</strong>, sortValue: (r) => r.incomePesewas, align: "right" },
          ]}
          rows={p.perDriver}
          rowKey={(r) => r.userId}
          onRowClick={(r) => navigate(withParams(path, search, { driver: r.driverId ?? r.userId }))}
          rowLabel={(r) => `Open ${r.name}`}
          searchText={(r) => `${r.name} ${r.plate ?? ""}`}
          searchLabel="Search drivers"
          empty="No trips or top-ups in this period."
          initialSort={{ key: "income", dir: "desc" }}
        />
      </Section>
      <Section
        title="Per day"
        actions={
          <CsvButton
            filename="driver-income-per-day.csv"
            header={["Day", "Trips", "Fares GHS", "Commission due GHS", "Top-ups GHS", "Total income GHS"]}
            rows={() => p.perDay.map((d) => [d.day, d.trips, d.faresPesewas / 100, d.commissionDuePesewas / 100, d.topUpsPesewas / 100, d.incomePesewas / 100])}
          />
        }
      >
        <DataTable
          columns={[
            { key: "day", header: "Day", render: (d) => humanDay(d.day), sortValue: (d) => d.day },
            { key: "trips", header: "Trips", render: (d) => <span className="num">{d.trips}</span>, sortValue: (d) => d.trips, align: "right" },
            { key: "fares", header: "Fares", render: (d) => <span className="num">{cedis(d.faresPesewas)}</span>, sortValue: (d) => d.faresPesewas, align: "right" },
            { key: "topups", header: "Top-ups", render: (d) => <span className="num">{cedis(d.topUpsPesewas)}</span>, sortValue: (d) => d.topUpsPesewas, align: "right" },
            { key: "income", header: "Fares + top-ups", render: (d) => <strong className="num">{cedis(d.incomePesewas)}</strong>, sortValue: (d) => d.incomePesewas, align: "right" },
          ]}
          rows={p.perDay}
          rowKey={(d) => d.day}
          initialSort={{ key: "day", dir: "desc" }}
          pageSize={31}
        />
      </Section>
    </>
  );
}

function TopUpsTab({ p, refresh, readOnly }: { p: Payouts; refresh: () => void; readOnly: boolean }) {
  const token = useToken();
  const toast = useToast();
  const [removing, setRemoving] = useState<TopUp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {readOnly ? null : <RecordTopUp onDone={refresh} />}
      <Section
        title="Top-ups in this period"
        actions={
          <CsvButton
            filename="top-ups.csv"
            header={["Day", "Driver", "Amount GHS", "Method", "Note", "Recorded by", "Recorded at", "Removed"]}
            rows={() =>
              p.topUps.map((t) => [t.paidOn, t.driver.name, t.amountPesewas / 100, METHOD_LABEL[t.method], t.note ?? "", t.recordedBy, t.createdAt, t.removed ? `Removed: ${t.removed.reason ?? ""}` : ""])
            }
          />
        }
      >
        <DataTable
          columns={[
            { key: "day", header: "For", render: (t) => humanDay(t.paidOn), sortValue: (t) => t.paidOn },
            { key: "driver", header: "Driver", render: (t) => <strong>{t.driver.name}</strong>, sortValue: (t) => t.driver.name },
            {
              key: "amount",
              header: "Amount",
              render: (t) => <span className={`num${t.removed ? " muted" : ""}`} style={t.removed ? { textDecoration: "line-through" } : undefined}>{cedis(t.amountPesewas)}</span>,
              sortValue: (t) => t.amountPesewas,
              align: "right",
            },
            { key: "method", header: "Method", render: (t) => <Chip tone={t.method === "MOMO" ? "amber" : "neutral"}>{METHOD_LABEL[t.method]}</Chip> },
            { key: "note", header: "Note", render: (t) => (t.removed ? <span className="muted">Removed: {t.removed.reason}</span> : (t.note ?? <span className="muted">—</span>)) },
            { key: "by", header: "Recorded", render: (t) => <span className="small">{t.recordedBy} · {dayAndTime(t.createdAt)}</span>, phoneHidden: true },
            {
              key: "act",
              header: "",
              render: (t) =>
                t.removed || readOnly ? null : (
                  <button type="button" className="danger-text-button small" onClick={() => setRemoving(t)}>
                    Remove
                  </button>
                ),
            },
          ]}
          rows={p.topUps}
          rowKey={(t) => t.id}
          searchText={(t) => `${t.driver.name} ${t.note ?? ""}`}
          searchLabel="Search top-ups"
          empty="No top-ups recorded for this period."
        />
      </Section>
      {removing ? (
        <ConfirmDialog
          title="Remove this top-up?"
          confirmLabel="Remove top-up"
          danger
          busy={busy}
          error={error}
          reasonLabel="Why? (kept in the audit log)"
          reasonPlaceholder="e.g. Entered twice"
          onCancel={() => setRemoving(null)}
          onConfirm={async (reason) => {
            setBusy(true);
            setError(null);
            try {
              await removeTopUp(token, removing.id, reason);
              toast("Top-up removed");
              setRemoving(null);
              refresh();
            } catch (err) {
              setError(err instanceof ApiError ? failureText("Removing the top-up", err) : "Removing failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            {cedis(removing.amountPesewas)} to {removing.driver.name} for {humanDay(removing.paidOn)}. It stays on record, marked removed.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/**
 * Payouts & commission: what drivers made (fares − commission due +
 * top-ups, per driver and per day, CSV), the top-ups CampusRide paid them,
 * and the commission: the rate, the waiver, and what each driver owes,
 * paid and still owes (the commission ledger, unchanged).
 */
export function MoneyPage() {
  const token = useToken();
  const { search, setParams } = useRouter();
  const { refreshSummary } = useShell();
  const investor = useInvestorView();
  const tab = (search.get("tab") as Tab | null) ?? "income";
  const [period, setPeriod] = usePagePeriod("money", "this-week");
  const query = periodQuery(period);
  const payouts = usePolled(() => getPayouts(token, query), `payouts|${query}`, undefined, "Loading payouts");
  const refresh = () => {
    payouts.refresh();
    refreshSummary();
  };

  return (
    <Page
      title="Payouts & commission"
      subtitle={tab === "commission" ? "What drivers owe CampusRide, and the rules" : periodLabel(period)}
      controls={tab === "commission" ? undefined : <Freshness updatedAt={payouts.updatedAt} onRefresh={refresh} loading={payouts.loading} />}
    >
      <nav className="page-tabs" aria-label="Payouts and commission">
        {TABS.map((t) => (
          <Link
            key={t.value}
            to={`/money${t.value === "income" ? "" : `?tab=${t.value}`}`}
            className={tab === t.value ? "page-tab active" : "page-tab"}
            aria-current={tab === t.value ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              setParams({ tab: t.value === "income" ? null : t.value }, { replace: true });
            }}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "commission" ? (
        <>
          <CommissionTermsCard readOnly={investor.on} />
          <CashOwedPage embedded />
        </>
      ) : (
        <>
          <div className="toolbar">
            <PeriodPicker value={period} onChange={setPeriod} choices={["today", "this-week", "last-week", "since-launch"]} />
          </div>
          <Loaded {...payouts} onRetry={payouts.refresh} what="Loading payouts…">
            {(p) => (tab === "topups" ? <TopUpsTab p={p} refresh={refresh} readOnly={investor.on} /> : <IncomeTab p={p} />)}
          </Loaded>
        </>
      )}
    </Page>
  );
}
