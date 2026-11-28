import { useState } from "react";
import { Collapsible } from "../components/Collapsible";
import { ApiError, type CommissionReconciliation, getCash, getPayments, recordPayment, reversePayment, waiveAllBalances, type CashDriverRow, type CashMethod, type CashPayment } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CsvButton } from "../components/CsvButton";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { StatTile } from "../components/StatTile";
import { Loaded } from "../components/States";
import { useToast } from "../components/Toast";
import { cedis, cedisInput, parseCedis } from "../lib/money";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter } from "../lib/router";
import { ago, dayAndTime, isoDay } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { WaitFeesSection } from "../screens/WaitFeesSection";
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";

const METHODS: Array<{ value: CashMethod; label: string }> = [
  { value: "CASH", label: "Cash" },
  { value: "MOMO", label: "MoMo" },
  { value: "OTHER", label: "Other" },
];
const METHOD_LABEL: Record<NonNullable<CashPayment["method"]>, string> = { CASH: "Cash", MOMO: "MoMo", OTHER: "Other", PAYSTACK: "Paystack" };
const methodLabel = (p: CashPayment) => (p.method ? METHOD_LABEL[p.method] : "—");

/** The page frame, or just its content inside Payouts & commission. */
function Frame({ embedded, controls, children }: { embedded: boolean; controls: React.ReactNode; children: React.ReactNode }) {
  if (embedded) return <>{children}</>;
  return (
    <Page title="Commission owed" subtitle="Riders pay drivers in cash. Drivers owe CampusRide the commission on each fare." controls={controls}>
      {children}
    </Page>
  );
}

/** Earned = Paid + Waived + Still owed (− paid ahead): the commission totals, all time, that always add up. */
export function Reconciliation({ r }: { r: CommissionReconciliation }) {
  return (
    <div className="stack-tight">
      <div className="equation" role="group" aria-label="Commission earned equals paid plus waived plus still owed">
        <StatTile dark label="Commission earned" value={cedis(r.earnedPesewas)} note="All time, at the rate on each trip" />
        <span className="op" aria-hidden="true">=</span>
        <StatTile label="Paid" value={cedis(r.paidPesewas)} note="In person and Paystack" />
        <span className="op" aria-hidden="true">+</span>
        <StatTile label="Waived" value={cedis(r.waivedPesewas)} note={`${cedis(r.commissionWaivedPesewas)} trips · ${cedis(r.balanceWaivedPesewas)} balances`} />
        <span className="op" aria-hidden="true">+</span>
        <StatTile label="Still owed" value={cedis(r.stillOwedPesewas)} note={r.paidAheadPesewas ? `− ${cedis(r.paidAheadPesewas)} paid ahead` : "By drivers"} />
      </div>
      <p className="muted small">
        Waived = commission on trips completed while commission was waived, plus balances an admin forgave. A balance waiver only counts up to what the driver
        owed at the time, so nothing is waived twice.
      </p>
    </div>
  );
}

export const CASH_STATUS: Record<CashDriverRow["status"], { label: string; tone: "green" | "amber" | "red" }> = {
  PAID: { label: "Paid", tone: "green" },
  PART_PAID: { label: "Part paid", tone: "amber" },
  NOT_PAID: { label: "Not paid", tone: "red" },
};

/** "from last week", "from 3 days ago": how old the oldest unpaid amount is. */
export function oldestWords(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "nothing unpaid";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "oldest from today";
  if (days < 2) return "oldest from yesterday";
  if (days < 7) return `oldest from ${days} days ago`;
  if (days < 14) return "oldest from last week";
  return `oldest from ${Math.floor(days / 7)} weeks ago`;
}

/** Records cash (or MoMo) a driver handed over in person. Used here and on the Driver page ("Mark as paid"). */
export function RecordPayment({ driver, onDone, onCancel }: { driver: Pick<CashDriverRow, "userId" | "name" | "balancePesewas">; onDone: () => void; onCancel: () => void }) {
  const token = useToken();
  const [amount, setAmount] = useState(driver.balancePesewas > 0 ? cedisInput(driver.balancePesewas) : "");
  const [method, setMethod] = useState<CashMethod>("CASH");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pesewas = parseCedis(amount);
  const tooMuch = pesewas !== null && driver.balancePesewas > 0 && pesewas > driver.balancePesewas;

  return (
    <div className="modal-layer">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pay-title">
        <h2 id="pay-title">Record a payment from {driver.name}</h2>
        <p className="modal-text">
          Still owed: <strong className="num">{cedis(driver.balancePesewas)}</strong>. A part payment is fine. Payments can&apos;t be edited later, only reversed.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (pesewas === null || pesewas <= 0) {
              setError("Type an amount in cedis, like 25 or 12.50.");
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await recordPayment(token, { driverId: driver.userId, amountPesewas: pesewas, method, note: note.trim() || null, paidAt: new Date(`${date}:00Z`).toISOString() });
              onDone();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "The payment wasn't saved");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>Amount (GH₵)</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
          </label>
          {tooMuch ? <p className="warn-text">That&apos;s more than they owe; the rest counts as paid ahead.</p> : null}
          <fieldset className="field">
            <legend>How they paid</legend>
            <div className="segmented">
              {METHODS.map((m) => (
                <label key={m.value} className={method === m.value ? "seg active" : "seg"}>
                  <input type="radio" name="method" className="sr-only" value={m.value} checked={method === m.value} onChange={() => setMethod(m.value)} />
                  {m.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>When (Ghana time)</span>
            <input type="datetime-local" value={date} max={new Date().toISOString().slice(0, 16)} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <input value={note} maxLength={500} placeholder="e.g. MoMo ref 12345" onChange={(e) => setNote(e.target.value)} />
          </label>
          {error ? <p className="error-text" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={busy || pesewas === null || pesewas <= 0}>
              {busy ? "Saving…" : `Record ${pesewas ? cedis(pesewas) : "payment"}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Finances: riders pay drivers in cash, and drivers owe CampusRide 15% of
 * each fare. What's still owed (all time); what was earned, collected
 * (through Paystack in the driver app, and in person) and waived in the
 * period; every driver's balance, recording a payment, waiving every
 * balance at once; and the payments and waivers logs (reversible, never
 * edited). Formula: docs/admin-metrics.md.
 */
export function CashOwedPage({ embedded = false }: { embedded?: boolean } = {}) {
  const token = useToken();
  const toast = useToast();
  const { refreshSummary } = useShell();
  const { search, setParams } = useRouter();
  const [period, setPeriod] = usePagePeriod("cash", "this-week");
  const driverFilter = search.get("driverId") ?? "";
  const query = periodQuery(period);
  const cash = usePolled(() => getCash(token, query), query);
  const [logPage, setLogPage] = useState(1);
  const payments = usePolled(() => getPayments(token, { period: query, driverId: driverFilter || undefined, kind: "PAYMENT", page: logPage }), `${query}|${driverFilter}|${logPage}`);
  const [waiverPage, setWaiverPage] = useState(1);
  const waivers = usePolled(
    () => getPayments(token, { period: query, driverId: driverFilter || undefined, kind: "WAIVER", page: waiverPage }),
    `waivers|${query}|${driverFilter}|${waiverPage}`,
  );
  const [waivingAll, setWaivingAll] = useState(false);
  const [paying, setPaying] = useState<CashDriverRow | null>(null);
  const [reversing, setReversing] = useState<CashPayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = () => {
    cash.refresh();
    payments.refresh();
    waivers.refresh();
    refreshSummary();
  };

  return (
    <Frame embedded={embedded} controls={<Freshness updatedAt={cash.updatedAt} onRefresh={changed} loading={cash.loading} />}>
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} choices={["this-week", "last-week", "this-month", "all-time"]} />
        <span className="muted">{periodLabel(period)}</span>
      </div>
      <Loaded {...cash} onRetry={cash.refresh}>
        {(c) => (
          <>
            {c.reconciliation ? <Reconciliation r={c.reconciliation} /> : null}
            <Collapsible
              id="commission.period"
              title={`In this range: ${periodLabel(period)}`}
              hint="Commission charged and waived on the range's trips, and what came in, by how it was paid."
              aside={cedis(c.paidInPeriodPesewas)}
            >
              <div className="kpi-grid">
                <StatTile label="Commission charged" value={cedis(c.earnedInPeriodPesewas)} note={`On ${cedis(c.faresInPeriodPesewas)} in fares`} />
                <StatTile label="Commission waived" value={cedis(c.waivedCommissionInPeriodPesewas ?? 0)} note="Trips completed while waived" />
                <StatTile label="Collected" value={cedis(c.paidInPeriodPesewas)} note={`${c.paymentsInPeriod} ${c.paymentsInPeriod === 1 ? "payment" : "payments"}`} />
                <StatTile label="Via Paystack" value={cedis(c.collectedPaystackPesewas)} note="Paid by drivers in the app" />
                <StatTile label="In person" value={cedis(c.collectedInPersonPesewas)} note="Recorded by an admin" />
                <StatTile
                  label="Paystack fees paid by drivers"
                  value={cedis(c.paystackFeesPaidByDriversPesewas)}
                  note={c.paystackFeesChargedPesewas ? `Paystack kept ${cedis(c.paystackFeesChargedPesewas)}` : "Added on top of their balance"}
                />
              </div>
            </Collapsible>

            <Section
              title="By driver, all time"
              actions={
                c.outstandingPesewas > 0 ? (
                  <button type="button" className="danger-text-button" onClick={() => setWaivingAll(true)}>
                    Waive all balances
                  </button>
                ) : null
              }
            >
              <DataTable
                columns={[
                  { key: "driver", header: "Driver", render: (d) => <strong>{d.name}</strong>, sortValue: (d) => d.name },
                  { key: "earned", header: "Commission earned", render: (d) => <span className="num">{cedis(d.earnedPesewas ?? 0)}</span>, sortValue: (d) => d.earnedPesewas ?? 0, align: "right" },
                  { key: "paid", header: "Paid", render: (d) => <span className="num">{cedis(d.allPaidPesewas ?? 0)}</span>, sortValue: (d) => d.allPaidPesewas ?? 0, align: "right" },
                  { key: "waived", header: "Waived", render: (d) => <span className="num">{cedis(d.allWaivedPesewas ?? 0)}</span>, sortValue: (d) => d.allWaivedPesewas ?? 0, align: "right" },
                  {
                    key: "still",
                    header: "Still owed",
                    render: (d) => (
                      <span className="num">
                        <strong>{cedis(Math.max(0, d.balancePesewas))}</strong>
                        {d.balancePesewas < 0 ? <span className="muted small block">{cedis(-d.balancePesewas)} paid ahead</span> : null}
                        {d.balancePesewas > 0 && d.oldestUnpaidAt ? <span className="muted small block">{oldestWords(d.oldestUnpaidAt)}</span> : null}
                      </span>
                    ),
                    sortValue: (d) => d.balancePesewas,
                    align: "right",
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (d) => <Chip tone={CASH_STATUS[d.status].tone}>{CASH_STATUS[d.status].label}</Chip>,
                    sortValue: (d) => d.status,
                  },
                  {
                    key: "action",
                    header: "Action",
                    render: (d) =>
                      d.balancePesewas > 0 ? (
                        <button type="button" className="tonal-button small" onClick={() => setPaying(d)}>
                          Record payment
                        </button>
                      ) : (
                        <span className="muted">Settled</span>
                      ),
                  },
                ]}
                rows={c.drivers}
                rowKey={(d) => d.userId}
                empty="No driver owes anything, and nothing was paid in this period."
                initialSort={{ key: "still", dir: "desc" }}
              />
            </Section>
          </>
        )}
      </Loaded>

      <Collapsible id="commission.waitfees" title="Wait fees" hint="Fees riders paid for keeping the driver waiting, and no-shows, in this range.">
        <WaitFeesSection query={query} />
      </Collapsible>

      <Collapsible id="commission.payments" title="Payments" hint="Every payment drivers made, in person or through Paystack, with reversals. Download as CSV.">
      <Section
        title="Payments"
        actions={
          <>
            {driverFilter ? (
              <button type="button" className="text-button" onClick={() => setParams({ driverId: null }, { replace: true })}>
                Show every driver
              </button>
            ) : null}
            <CsvButton
              filename={`campusride-cash-payments-${isoDay(period.from)}.csv`}
              header={["Payment ID", "Paid (UTC)", "Driver", "Amount (GHS)", "Method", "Paystack reference", "Driver paid (GHS)", "Fee (GHS)", "Note", "Recorded by", "Recorded (UTC)", "Reverses", "Reason"]}
              rows={async () =>
                (await getPayments(token, { period: query, driverId: driverFilter || undefined, kind: "PAYMENT", page: 1, pageSize: 2000 })).payments.map((p) => [
                  p.id,
                  p.paidAt,
                  p.driver.name,
                  (p.amountPesewas / 100).toFixed(2),
                  methodLabel(p),
                  p.paystack?.reference ?? null,
                  p.paystack ? (p.paystack.grossPesewas / 100).toFixed(2) : null,
                  p.paystack ? (p.paystack.feePesewas / 100).toFixed(2) : null,
                  p.note,
                  p.recordedBy.name,
                  p.createdAt,
                  p.reversesId,
                  p.reversalReason,
                ])
              }
            />
          </>
        }
      >
        <DataTable
          columns={[
            { key: "when", header: "Paid", render: (p) => <span className="num nowrap">{dayAndTime(p.paidAt)}</span>, sortValue: (p) => p.paidAt },
            { key: "driver", header: "Driver", render: (p) => <strong>{p.driver.name}</strong>, sortValue: (p) => p.driver.name },
            {
              key: "amount",
              header: "Amount",
              render: (p) => <span className={`num${p.amountPesewas < 0 ? " negative" : ""}`}>{cedis(p.amountPesewas)}</span>,
              sortValue: (p) => p.amountPesewas,
              align: "right",
            },
            { key: "method", header: "Method", render: (p) => methodLabel(p) },
            {
              key: "reference",
              header: "Reference",
              render: (p) => (p.paystack ? <span className="num small">{p.paystack.reference}</span> : <span className="muted">—</span>),
              phoneHidden: true,
            },
            {
              key: "note",
              header: "Note",
              render: (p) =>
                p.reversesId ? (
                  <span>
                    <Chip tone="red">Reversal</Chip> {p.reversalReason}
                  </span>
                ) : p.reversedBy ? (
                  <span>
                    <Chip>Reversed</Chip> <span className="muted">{p.reversedBy.reason}</span>
                  </span>
                ) : (
                  (p.note ?? <span className="muted">—</span>)
                ),
              phoneHidden: true,
            },
            { key: "by", header: "Recorded by", render: (p) => <span title={dayAndTime(p.createdAt)}>{p.recordedBy.name}, {ago(p.createdAt)}</span>, phoneHidden: true },
            {
              key: "reverse",
              header: "Action",
              render: (p) =>
                !p.reversesId && !p.reversedBy ? (
                  <button type="button" className="danger-text-button small" onClick={() => setReversing(p)}>
                    Reverse
                  </button>
                ) : null,
            },
          ]}
          rows={payments.data?.payments ?? null}
          loading={payments.loading}
          error={payments.error}
          onRetry={payments.refresh}
          rowKey={(p) => p.id}
          empty="No payments in this period."
          paging={payments.data ? { page: logPage, pageSize: payments.data.pageSize, total: payments.data.total, onPage: setLogPage } : undefined}
        />
        <p className="muted small">
          Every payment and reversal is saved in the audit log with who recorded it. Payments are never edited or deleted. Paystack payments are recorded by
          themselves once Paystack confirms them; the reference matches the Paystack dashboard.
        </p>
      </Section>
      </Collapsible>

      <Collapsible id="commission.waivers" title="Waivers" hint="Balances an admin forgave, with the reason.">
      <Section
        title="Waivers"
        actions={
          <CsvButton
            filename={`campusride-waivers-${isoDay(period.from)}.csv`}
            header={["Waiver ID", "When (UTC)", "Driver", "Amount (GHS)", "Reason", "Waived by", "Reverses", "Reversal reason"]}
            rows={async () =>
              (await getPayments(token, { period: query, driverId: driverFilter || undefined, kind: "WAIVER", page: 1, pageSize: 2000 })).payments.map((p) => [
                p.id,
                p.paidAt,
                p.driver.name,
                (p.amountPesewas / 100).toFixed(2),
                p.note,
                p.recordedBy.name,
                p.reversesId,
                p.reversalReason,
              ])
            }
          />
        }
      >
        <DataTable
          columns={[
            { key: "when", header: "When", render: (p) => <span className="num nowrap">{dayAndTime(p.paidAt)}</span>, sortValue: (p) => p.paidAt },
            { key: "driver", header: "Driver", render: (p) => <strong>{p.driver.name}</strong>, sortValue: (p) => p.driver.name },
            {
              key: "amount",
              header: "Amount",
              render: (p) => <span className={`num${p.amountPesewas < 0 ? " negative" : ""}`}>{cedis(p.amountPesewas)}</span>,
              sortValue: (p) => p.amountPesewas,
              align: "right",
            },
            {
              key: "reason",
              header: "Reason",
              render: (p) =>
                p.reversesId ? (
                  <span>
                    <Chip tone="red">Reversal</Chip> {p.reversalReason}
                  </span>
                ) : p.reversedBy ? (
                  <span>
                    <Chip>Reversed</Chip> {p.note}
                  </span>
                ) : (
                  p.note
                ),
            },
            { key: "by", header: "Waived by", render: (p) => <span title={dayAndTime(p.createdAt)}>{p.recordedBy.name}</span>, phoneHidden: true },
            {
              key: "reverse",
              header: "Action",
              render: (p) =>
                !p.reversesId && !p.reversedBy ? (
                  <button type="button" className="danger-text-button small" onClick={() => setReversing(p)}>
                    Reverse
                  </button>
                ) : null,
            },
          ]}
          rows={waivers.data?.payments ?? null}
          loading={waivers.loading}
          error={waivers.error}
          onRetry={waivers.refresh}
          rowKey={(p) => p.id}
          empty="No waivers in this period."
          paging={waivers.data ? { page: waiverPage, pageSize: waivers.data.pageSize, total: waivers.data.total, onPage: setWaiverPage } : undefined}
        />
      </Section>
      </Collapsible>

      {paying ? (
        <RecordPayment
          driver={paying}
          onCancel={() => setPaying(null)}
          onDone={() => {
            toast(`Payment from ${paying.name} recorded`);
            setPaying(null);
            changed();
          }}
        />
      ) : null}
      {reversing ? (
        <ConfirmDialog
          title={reversing.kind === "WAIVER" ? `Reverse the ${cedis(reversing.amountPesewas)} waiver for ${reversing.driver.name}?` : `Reverse ${cedis(reversing.amountPesewas)} from ${reversing.driver.name}?`}
          confirmLabel={reversing.kind === "WAIVER" ? "Reverse waiver" : "Reverse payment"}
          danger
          reasonLabel="Why (saved with the reversal)"
          reasonPlaceholder="e.g. Recorded against the wrong driver"
          busy={busy}
          error={error}
          onCancel={() => {
            setReversing(null);
            setError(null);
          }}
          onConfirm={async (reason) => {
            setBusy(true);
            setError(null);
            try {
              await reversePayment(token, reversing.id, reason);
              toast(reversing.kind === "WAIVER" ? "Waiver reversed" : "Payment reversed");
              setReversing(null);
              changed();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "The reversal wasn't saved");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>This adds a negative entry of the same amount, so the driver owes it again. The original stays in the log.</p>
        </ConfirmDialog>
      ) : null}
      {waivingAll ? (
        <ConfirmDialog
          title={`Waive every driver's balance (${cedis(cash.data?.outstandingPesewas ?? 0)} in all)?`}
          confirmLabel="Waive all balances"
          danger
          reasonLabel="Why (saved with every waiver)"
          reasonPlaceholder="e.g. Commission-free launch period, November 2026"
          busy={busy}
          error={error}
          onCancel={() => {
            setWaivingAll(false);
            setError(null);
          }}
          onConfirm={async (reason) => {
            setBusy(true);
            setError(null);
            try {
              const result = await waiveAllBalances(token, reason);
              toast(`${cedis(result.totalPesewas)} waived for ${result.drivers} ${result.drivers === 1 ? "driver" : "drivers"}`);
              setWaivingAll(false);
              changed();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "The waivers weren't saved");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            Every driver who owes anything gets a waiver for their whole balance now, with your name and this reason. Commission from trips after this stays owed.
            Each waiver can be reversed later.
          </p>
        </ConfirmDialog>
      ) : null}
    </Frame>
  );
}
