import { useState } from "react";
import { getAudit, getSystem } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { Loaded } from "../components/States";
import { usePolled } from "../lib/usePolled";
import { dayAndTime, ago } from "../lib/time";
import { AdminLoginsScreen } from "../screens/AdminLoginsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { Page, Section } from "../shell/Page";

function AuditLog() {
  const token = useToken();
  const [action, setAction] = useState("");
  const [term, setTerm] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const log = usePolled(() => getAudit(token, { action, q, page }), `${action}|${q}|${page}`);
  return (
    <>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(term.trim());
          setPage(1);
        }}
      >
        <label className="field">
          <span>Action</span>
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
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Search target or reason</span>
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} />
        </label>
        <button type="submit" className="tonal-button">
          Search
        </button>
      </form>
      <DataTable
        columns={[
          { key: "at", header: "When", render: (e) => <span className="num nowrap">{dayAndTime(e.at)}</span> },
          { key: "who", header: "Admin", render: (e) => e.actor?.name ?? <span className="muted">Server or unknown</span> },
          { key: "action", header: "Action", render: (e) => <code>{e.action}</code> },
          { key: "target", header: "Target", render: (e) => <span className="muted small break">{e.target}</span>, phoneHidden: true },
          { key: "reason", header: "Details", render: (e) => e.reason ?? <span className="muted">—</span> },
        ]}
        rows={log.data?.entries ?? null}
        loading={log.loading}
        error={log.error}
        onRetry={log.refresh}
        rowKey={(e) => e.id}
        empty="Nothing in the audit log matches."
        paging={log.data ? { page, pageSize: log.data.pageSize, total: log.data.total, onPage: setPage } : undefined}
      />
    </>
  );
}

function SystemFacts() {
  const token = useToken();
  const sys = usePolled(() => getSystem(token), "system");
  return (
    <Loaded {...sys} onRetry={sys.refresh}>
      {(s) => (
        <dl className="facts">
          <div>
            <dt>Review demo mode</dt>
            <dd>
              {s.reviewDemo.enabled ? <Chip tone="amber">On</Chip> : <Chip>Off</Chip>}
              {s.reviewDemo.problems.length ? <span className="muted"> Switched on but not working: {s.reviewDemo.problems.join("; ")}</span> : null}
            </dd>
          </div>
          {(["rider", "driver"] as const).map((app) => (
            <div key={app}>
              <dt>{app === "rider" ? "Rider app" : "Driver app"} minimum version</dt>
              <dd>
                iPhone {s.minVersions[app]?.ios?.minVersion ?? "none"} · Android {s.minVersions[app]?.android?.minVersion ?? "none"}
              </dd>
            </div>
          ))}
          <div>
            <dt>Server version</dt>
            <dd className="num">{s.server.commit ?? "not known (not built on Render)"}</dd>
          </div>
          <div>
            <dt>Last deploy or restart</dt>
            <dd>
              {dayAndTime(s.server.startedAt)} <span className="muted">({ago(s.server.startedAt)})</span>
            </dd>
          </div>
        </dl>
      )}
    </Loaded>
  );
}

/** Settings: launch mode and early access, the launch push, passkeys, admin sign-ins, the audit log, and read-only facts. */
export function SettingsPage() {
  return (
    <Page title="Settings" subtitle="Launch, access, sign-ins and the audit log">
      <SettingsScreen />
      <Section title="Admin sign-ins" className="anchor" >
        <span id="logins" />
        <AdminLoginsScreen />
      </Section>
      <Section title="Audit log">
        <AuditLog />
      </Section>
      <Section title="About this system">
        <SystemFacts />
      </Section>
    </Page>
  );
}
