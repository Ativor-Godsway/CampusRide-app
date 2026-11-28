import { useState } from "react";
import { getAudit } from "../api";
import { useToken } from "../auth";
import { DataTable } from "../components/DataTable";
import { Empty } from "../components/States";
import { usePolled } from "../lib/usePolled";
import { useInvestorView } from "../lib/useInvestorView";
import { dayAndTime } from "../lib/time";
import { Freshness, Page, Section } from "../shell/Page";

/** Plain words for the audit log's actions ("commission.terms" → "Commission rate or waiver changed"). */
export const ACTION_WORDS: Record<string, string> = {
  "admin.login.success": "Signed in",
  "admin.login.failure": "Failed sign-in",
  "admin.passkey.add": "Passkey added",
  "admin.passkey.remove": "Passkey removed",
  "cash.payment.record": "Commission payment recorded",
  "cash.payment.reverse": "Commission payment reversed",
  "cash.waive": "Driver balance waived",
  "cash.waive.all": "All balances waived",
  "commission.settings": "Commission rules changed",
  "commission.terms": "Commission rate or waiver changed",
  "dispatch.moving_first": "Fill moving cars first changed",
  "dispatch.search_window": "Search time changed",
  "driver.approve": "Driver approved",
  "driver.reject": "Driver not approved",
  "driver.suspend": "Driver suspended",
  "driver.unsuspend": "Suspension lifted",
  "driver.trail.view": "Location trail viewed",
  "fares.update": "Prices changed",
  "launch.update": "Launch mode changed",
  "notification.send": "Push notification sent",
  "notification.launch": "Launch push",
  "notification.opening": "Opening push",
  "payout.topup.record": "Top-up recorded",
  "payout.topup.remove": "Top-up removed",
  "place.create": "Place added",
  "ride.cancel": "Ride cancelled",
  "ride.seat.cancel": "Seat cancelled",
  "ride.wait_fee": "Wait fee changed",
  "schedule.settings": "Scheduled ride settings changed",
  "service_hours.override": "Service opened or closed now",
  "service_hours.update": "Service hours changed",
  "sos.handle": "SOS marked handled",
  "zones.neighbours": "Zone neighbours changed",
};

export function actionWords(action: string): string {
  return ACTION_WORDS[action] ?? action;
}

function AuditTable() {
  const token = useToken();
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [term, setTerm] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const log = usePolled(() => getAudit(token, { action, actor, q, page }), `${action}|${actor}|${q}|${page}`, undefined, "Loading the audit log");
  return (
    <Section
      title="Every change, newest first"
      actions={<Freshness updatedAt={log.updatedAt} onRefresh={log.refresh} loading={log.loading} />}
    >
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(term.trim());
          setPage(1);
        }}
      >
        <label className="field">
          <span>What</span>
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Every action</option>
            {(log.data?.actions ?? []).map((a) => (
              <option key={a} value={a}>
                {actionWords(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Admin</span>
          <select
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Every admin</option>
            {(log.data?.admins ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Search details</span>
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. a ride id or a word in the reason" />
        </label>
        <button type="submit" className="tonal-button">
          Search
        </button>
      </form>
      <DataTable
        columns={[
          { key: "at", header: "When", render: (e) => <span className="num nowrap">{dayAndTime(e.at)}</span> },
          { key: "who", header: "Admin", render: (e) => e.actor?.name ?? <span className="muted">Server or unknown</span> },
          { key: "action", header: "What", render: (e) => <span title={e.action}>{actionWords(e.action)}</span> },
          { key: "reason", header: "Details", render: (e) => e.reason ?? <span className="muted">—</span> },
          { key: "target", header: "Target", render: (e) => <span className="muted small break">{e.target}</span>, phoneHidden: true },
        ]}
        rows={log.data?.entries ?? null}
        loading={log.loading}
        error={log.error}
        onRetry={log.refresh}
        rowKey={(e) => e.id}
        empty="Nothing in the audit log matches."
        paging={log.data ? { page, pageSize: log.data.pageSize, total: log.data.total, onPage: setPage } : undefined}
      />
    </Section>
  );
}

/** The audit log: every admin change and sign-in, who and when. Hidden in investor view. */
export function AuditPage() {
  const investor = useInvestorView();
  return (
    <Page title="Audit log" subtitle="Every change made on this site, and every admin sign-in: who, what and when">
      {investor.on ? <Empty>The audit log is hidden in investor view. Switch investor view off to see it.</Empty> : <AuditTable />}
    </Page>
  );
}
