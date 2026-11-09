import { useState } from "react";
import { ApiError, getDriverLedger, waiveBalance, type LedgerEntry, type PaymentMethodLabel } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { CsvButton } from "../components/CsvButton";
import { DataTable } from "../components/DataTable";
import { StatTile } from "../components/StatTile";
import { useToast } from "../components/Toast";
import { cedis, cedisInput, parseCedis } from "../lib/money";
import { dayAndTime, isoDay } from "../lib/time";
import { usePolled } from "../lib/usePolled";
import { RecordPayment } from "./CashOwed";

export const METHOD_LABELS: Record<PaymentMethodLabel, string> = { CASH: "Cash", MOMO: "MoMo", OTHER: "Other", PAYSTACK: "Paystack (in the app)" };

/** "Trip commission", "Paid: Cash", "Waived", "Reversal of a payment". */
export function ledgerLabel(e: Pick<LedgerEntry, "kind" | "method" | "isReversal">): string {
  const base =
    e.kind === "COMMISSION"
      ? "Trip commission"
      : e.kind === "WAIVER"
        ? "Waived"
        : e.kind === "ADJUSTMENT"
          ? "Adjustment"
          : `Paid: ${e.method ? METHOD_LABELS[e.method] : "—"}`;
  return e.isReversal ? `Reversal (${base.toLowerCase()})` : base;
}

/** What else to say about an entry: the trip, the Paystack reference and MoMo, the note or reason. */
function ledgerDetail(e: LedgerEntry): string {
  if (e.kind === "COMMISSION") return e.route ?? "";
  const parts: string[] = [];
  if (e.reference) parts.push(e.reference);
  if (e.momoNetwork) parts.push(`${e.momoNetwork}${e.phoneLast4 ? ` •••${e.phoneLast4}` : ""}`);
  if (e.grossPesewas !== null && e.feePesewas) parts.push(`paid ${cedis(e.grossPesewas)} incl. ${cedis(e.feePesewas)} fee`);
  if (e.note) parts.push(e.note);
  return parts.join(" · ");
}

function WaiveDialog({ name, balancePesewas, onSave, onCancel }: { name: string; balancePesewas: number; onSave: (pesewas: number, reason: string) => Promise<void>; onCancel: () => void }) {
  const [amount, setAmount] = useState(cedisInput(balancePesewas));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pesewas = parseCedis(amount);
  const tooMuch = pesewas !== null && pesewas > balancePesewas;
  return (
    <div className="modal-layer">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="waive-title">
        <h2 id="waive-title">Waive what {name} owes</h2>
        <p className="modal-text">
          Owed now: <strong className="num">{cedis(balancePesewas)}</strong>. The waiver is saved with your name and the reason, and can be reversed later.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (pesewas === null || pesewas <= 0 || tooMuch || !reason.trim()) return;
            setBusy(true);
            setError(null);
            try {
              await onSave(pesewas, reason.trim());
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "The waiver wasn't saved");
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>Amount to waive (GH₵)</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          {tooMuch ? <p className="error-text">That&apos;s more than they owe.</p> : null}
          <label className="field">
            <span>Why (required, saved with the waiver)</span>
            <textarea rows={3} maxLength={500} value={reason} placeholder="e.g. Commission-free first month" onChange={(e) => setReason(e.target.value)} required />
          </label>
          {error ? <p className="error-text" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={busy || pesewas === null || pesewas <= 0 || tooMuch || !reason.trim()}>
              {busy ? "Saving…" : `Waive ${pesewas && !tooMuch ? cedis(pesewas) : ""}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * A driver's commission balance on the Driver page: what they owe, the
 * history (each trip's 15%, payments in person and through Paystack,
 * waivers, reversals), "Mark as paid" for cash handed over in person, and
 * "Waive" with a reason. Both are saved with the admin's name.
 */
export function DriverBalancePanel({
  driver,
  balance,
  onChanged,
}: {
  driver: { userId: string; name: string };
  balance: { owedPesewas: number; paidPesewas: number; waivedPesewas: number; balancePesewas: number };
  onChanged: () => void;
}) {
  const token = useToken();
  const toast = useToast();
  const ledger = usePolled(() => getDriverLedger(token, driver.userId), `ledger:${driver.userId}`);
  const [action, setAction] = useState<"pay" | "waive" | null>(null);
  const changed = () => {
    setAction(null);
    ledger.refresh();
    onChanged();
  };

  return (
    <>
      <h3>Commission balance</h3>
      <div className="tiles tiles-2">
        <StatTile label="Owes now" value={cedis(Math.max(0, balance.balancePesewas))} note={balance.balancePesewas < 0 ? `${cedis(-balance.balancePesewas)} paid ahead` : undefined} />
        <StatTile label="Commission, all time" value={cedis(balance.owedPesewas)} />
        <StatTile label="Paid, all time" value={cedis(balance.paidPesewas)} />
        <StatTile label="Waived, all time" value={cedis(balance.waivedPesewas)} />
      </div>
      <div className="button-row">
        <button type="button" className="tonal-button" disabled={balance.balancePesewas <= 0} onClick={() => setAction("pay")}>
          Mark as paid
        </button>
        <button type="button" className="text-button" disabled={balance.balancePesewas <= 0} onClick={() => setAction("waive")}>
          Waive
        </button>
        <CsvButton
          filename={`campusride-balance-${driver.name.replace(/\W+/g, "-").toLowerCase()}-${isoDay(new Date())}.csv`}
          header={["When (UTC)", "What", "Effect (GHS)", "Details", "Recorded by"]}
          rows={async () => (await getDriverLedger(token, driver.userId)).entries.map((e) => [e.at, ledgerLabel(e), (e.effectPesewas / 100).toFixed(2), ledgerDetail(e), e.recordedBy])}
        />
      </div>
      <DataTable
        columns={[
          { key: "when", header: "When", render: (e) => <span className="num nowrap">{dayAndTime(e.at)}</span>, sortValue: (e) => e.at },
          {
            key: "what",
            header: "What",
            render: (e) => (e.isReversal ? <Chip tone="red">{ledgerLabel(e)}</Chip> : ledgerLabel(e)),
            sortValue: (e) => e.kind,
          },
          {
            key: "effect",
            header: "Owed",
            render: (e) => <span className={`num${e.effectPesewas < 0 ? " positive" : ""}`}>{e.effectPesewas > 0 ? "+" : ""}{cedis(e.effectPesewas)}</span>,
            sortValue: (e) => e.effectPesewas,
            align: "right",
          },
          { key: "detail", header: "Details", render: (e) => ledgerDetail(e) || <span className="muted">—</span>, phoneHidden: true },
          { key: "by", header: "Recorded by", render: (e) => e.recordedBy ?? <span className="muted">—</span>, phoneHidden: true },
        ]}
        rows={ledger.data?.entries ?? null}
        loading={ledger.loading}
        error={ledger.error}
        onRetry={ledger.refresh}
        rowKey={(e) => e.id}
        empty="No commission yet."
        pageSize={15}
        initialSort={{ key: "when", dir: "desc" }}
      />

      {action === "pay" ? (
        <RecordPayment
          driver={{ userId: driver.userId, name: driver.name, balancePesewas: balance.balancePesewas }}
          onCancel={() => setAction(null)}
          onDone={() => {
            toast(`Payment from ${driver.name} recorded`);
            changed();
          }}
        />
      ) : null}
      {action === "waive" ? (
        <WaiveDialog
          name={driver.name}
          balancePesewas={balance.balancePesewas}
          onCancel={() => setAction(null)}
          onSave={async (pesewas, reason) => {
            await waiveBalance(token, driver.userId, pesewas, reason);
            toast(`${cedis(pesewas)} waived for ${driver.name}`);
            changed();
          }}
        />
      ) : null}
    </>
  );
}
