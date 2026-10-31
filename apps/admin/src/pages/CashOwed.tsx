import { useState } from "react";
import { ApiError, getCash, getPayments, recordPayment, reversePayment, type CashDriverRow, type CashMethod, type CashPayment } from "../api";
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
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";

const METHODS: Array<{ value: CashMethod; label: string }> = [
  { value: "CASH", label: "Cash" },
  { value: "MOMO", label: "MoMo" },
  { value: "OTHER", label: "Other" },
];
const METHOD_LABEL: Record<CashMethod, string> = { CASH: "Cash", MOMO: "MoMo", OTHER: "Other" };

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

function RecordPayment({ driver, onDone, onCancel }: { driver: CashDriverRow; onDone: () => void; onCancel: () => void }) {
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
 * Cash owed: riders pay drivers in cash, and drivers owe CampusRide 15% of
 * each fare. What's still owed (all time), what was earned and paid in the
 * period, every driver's balance, recording a payment, and the payments log
 * (reversible, never edited). Formula: docs/admin-metrics.md.
 */
export function CashOwedPage() {
  const token = useToken();
  const toast = useToast();
  const { refreshSummary } = useShell();
  const { search, setParams } = useRouter();
  const [period, setPeriod] = usePagePeriod("cash", "this-week");
  const driverFilter = search.get("driverId") ?? "";
  const query = periodQuery(period);
  const cash = usePolled(() => getCash(token, query), query);
  const [logPage, setLogPage] = useState(1);
  const payments = usePolled(() => getPayments(token, { period: query, driverId: driverFilter || undefined, page: logPage }), `${query}|${driverFilter}|${logPage}`);
  const [paying, setPaying] = useState<CashDriverRow | null>(null);
  const [reversing, setReversing] = useState<CashPayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = () => {
    cash.refresh();
    payments.refresh();
    refreshSummary();
  };

  return (
    <Page title="Cash owed" subtitle="Riders pay drivers in cash. Drivers owe CampusRide 15% of each fare." controls={<Freshness updatedAt={cash.updatedAt} onRefresh={changed} loading={cash.loading} />}>
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} choices={["this-week", "last-week", "this-month", "all-time"]} />
        <span className="muted">{periodLabel(period)}</span>
      </div>
      <Loaded {...cash} onRetry={cash.refresh}>
        {(c) => (
          <>
            <div className="tiles tiles-hero">
              <div className="hero">
                <span className="hero-label">Still owed to CampusRide</span>
                <span className="hero-value num">{cedis(c.outstandingPesewas)}</span>
                <span className="hero-note">
                  {c.driversOwing} {c.driversOwing === 1 ? "driver" : "drivers"} · {oldestWords(c.oldestUnpaidAt)}
                </span>
              </div>
              <StatTile label="15% earned in this period" value={cedis(c.earnedInPeriodPesewas)} note={`From ${cedis(c.faresInPeriodPesewas)} in fares`} />
              <StatTile label="Paid in this period" value={cedis(c.paidInPeriodPesewas)} note={`${c.paymentsInPeriod} ${c.paymentsInPeriod === 1 ? "payment" : "payments"}`} />
            </div>

            <Section title="By driver">
              <DataTable
                columns={[
                  { key: "driver", header: "Driver", render: (d) => <strong>{d.name}</strong>, sortValue: (d) => d.name },
                  { key: "owed", header: "Owed this period", render: (d) => <span className="num">{cedis(d.owedInPeriodPesewas)}</span>, sortValue: (d) => d.owedInPeriodPesewas, align: "right" },
                  { key: "paid", header: "Paid", render: (d) => <span className="num">{cedis(d.paidInPeriodPesewas)}</span>, sortValue: (d) => d.paidInPeriodPesewas, align: "right" },
                  {
                    key: "still",
                    header: "Still owed",
                    render: (d) => (
                      <span className="num">
                        <strong>{cedis(Math.max(0, d.balancePesewas))}</strong>
                        {d.balancePesewas > d.owedInPeriodPesewas - d.paidInPeriodPesewas && d.balancePesewas > 0 ? (
                          <span className="muted small block">includes {cedis(d.balancePesewas - Math.max(0, d.owedInPeriodPesewas - d.paidInPeriodPesewas))} from before</span>
                        ) : null}
                        {d.balancePesewas < 0 ? <span className="muted small block">{cedis(-d.balancePesewas)} paid ahead</span> : null}
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

      <Section
        title="Payments recorded"
        actions={
          <>
            {driverFilter ? (
              <button type="button" className="text-button" onClick={() => setParams({ driverId: null }, { replace: true })}>
                Show every driver
              </button>
            ) : null}
            <CsvButton
              filename={`campusride-cash-payments-${isoDay(period.from)}.csv`}
              header={["Payment ID", "Paid (UTC)", "Driver", "Amount (GHS)", "Method", "Note", "Recorded by", "Recorded (UTC)", "Reverses", "Reason"]}
              rows={async () =>
                (await getPayments(token, { period: query, driverId: driverFilter || undefined, page: 1, pageSize: 2000 })).payments.map((p) => [
                  p.id,
                  p.paidAt,
                  p.driver.name,
                  (p.amountPesewas / 100).toFixed(2),
                  METHOD_LABEL[p.method],
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
            { key: "method", header: "Method", render: (p) => METHOD_LABEL[p.method] },
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
          empty="No payments recorded in this period."
          paging={payments.data ? { page: logPage, pageSize: payments.data.pageSize, total: payments.data.total, onPage: setLogPage } : undefined}
        />
        <p className="muted small">Every payment and reversal is saved in the audit log with who recorded it. Payments are never edited or deleted.</p>
      </Section>

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
          title={`Reverse ${cedis(reversing.amountPesewas)} from ${reversing.driver.name}?`}
          confirmLabel="Reverse payment"
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
              toast("Payment reversed");
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
    </Page>
  );
}
