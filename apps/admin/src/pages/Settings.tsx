import { useEffect, useState, type ReactNode } from "react";
import { getDispatchSettings, getSettingsChanges, getSystem, type SettingsSectionKey } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { ConfirmSubmit } from "../components/ConfirmSubmit";
import { Loaded } from "../components/States";
import { usePolled } from "../lib/usePolled";
import { useInvestorView } from "../lib/useInvestorView";
import { dayAndTime, ago } from "../lib/time";
import { Link } from "../lib/router";
import { AdminLoginsScreen } from "../screens/AdminLoginsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { CommissionRulesCard } from "../screens/CommissionRulesCard";
import { RideRequestsCard } from "../screens/RideRequestsCard";
import { WaitFeeCard } from "../screens/WaitFeeCard";
import { ScheduleSettingsCard } from "../screens/ScheduleSettingsCard";
import { PricesCard } from "../screens/PricesCard";
import { FarPricingCard } from "../screens/FarPricingCard";
import { PasskeysCard } from "../screens/PasskeysCard";
import { ServiceHoursCard } from "../screens/ServiceHoursCard";
import { Page, Section } from "../shell/Page";
import { CommissionTermsCard } from "./Money";

interface SectionDef {
  key: SettingsSectionKey;
  id: string;
  title: string;
  help: string;
}

/** The Settings sections, in order: plain-English titles and what each controls. */
export const SETTINGS_SECTIONS: SectionDef[] = [
  { key: "serviceHours", id: "service-hours", title: "Service hours", help: "When riders can book. Outside these hours the apps say when CampusRide opens. Switch it open or closed now with an override." },
  {
    key: "dispatch",
    id: "dispatch",
    title: "Dispatch",
    help: "How a request finds a driver: how long it searches, how long each driver's pop-up lasts, and whether cars already on a trip are filled first.",
  },
  { key: "pricing", id: "pricing", title: "Pricing", help: "What riders pay: Shared seat prices, far trips between the north and south ends, Ride alone, and the pickup wait fee." },
  { key: "scheduled", id: "scheduled", title: "Scheduled rides", help: "Booking a Shared ride ahead: the slots, when cars are offered to drivers, reminders and late cancels." },
  {
    key: "commission",
    id: "commission",
    title: "Commission",
    help: "CampusRide's share of each completed fare, the waiver for the commission-free launch, and when a driver who owes too much is stopped.",
  },
  { key: "notifications", id: "notifications", title: "Notifications & launch", help: "Launch mode and early access, the one-time launch push. Send a push to riders or drivers from Notifications." },
  { key: "admins", id: "admins", title: "Admin users", help: "Passkeys for signing in to this site, recent admin sign-ins, and facts about this system." },
];

/** "Last changed by Ama at Today 09:14", or "Not changed yet". */
export function lastChangedLine(change: { at: string; by: string } | null | undefined, now: number = Date.now()): string {
  if (!change) return "Not changed yet: the defaults apply";
  return `Last changed by ${change.by} · ${dayAndTime(change.at, now)}`;
}

function SystemFacts() {
  const token = useToken();
  const sys = usePolled(() => getSystem(token), "system", undefined, "Loading system facts");
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

/** The driver pop-up length: set on the server, shown here so it's clear where it comes from. */
function OfferSecondsLine() {
  const token = useToken();
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    getDispatchSettings(token).then((d) => setSeconds(d.offerSeconds ?? null), () => setSeconds(null));
  }, [token]);
  return (
    <div className="switch-row">
      <span>
        <strong>Driver pop-up: {seconds === null ? "—" : `${seconds} seconds`}</strong>
        <span className="muted small">
          How long each driver&apos;s new-request pop-up stays up before it moves on. Set on the server (DRIVER_OFFER_SECONDS on Render), not here.
        </span>
      </span>
    </div>
  );
}

function SettingsSection({ def, change, readOnly, children }: { def: SectionDef; change: { at: string; by: string } | null | undefined; readOnly: boolean; children: ReactNode }) {
  return (
    <Section
      className="settings-section"
      title={<span id={def.id}>{def.title}</span>}
      actions={<span className="section-meta">{readOnly ? "Changes hidden in investor view" : lastChangedLine(change)}</span>}
    >
      <p className="section-help">{def.help}</p>
      <fieldset className="read-only" disabled={readOnly}>
        <ConfirmSubmit what={def.title.toLowerCase()}>
          <div className="settings-stack">{children}</div>
        </ConfirmSubmit>
      </fieldset>
    </Section>
  );
}

/**
 * Settings, split into sections that each save on their own (with a
 * confirm) and say when they were last changed and by whom. In investor
 * view everything is read-only and who changed what is hidden.
 */
export function SettingsPage() {
  const token = useToken();
  const investor = useInvestorView();
  const changes = usePolled(() => getSettingsChanges(token), "settings-changes", undefined, "Loading when settings changed");
  const [active, setActive] = useState("service-hours");
  const change = (key: SettingsSectionKey) => changes.data?.sections[key] ?? null;
  const ro = investor.on;
  const def = (key: SettingsSectionKey) => SETTINGS_SECTIONS.find((s) => s.key === key)!;

  return (
    <Page title="Settings" subtitle="Each section saves on its own. Every change is written to the audit log.">
      <div className="settings-layout">
        <nav className="settings-index" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={active === s.id ? "active" : undefined}
              onClick={(e) => {
                e.preventDefault();
                setActive(s.id);
                document.getElementById(s.id)?.closest(".settings-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {s.title}
            </a>
          ))}
        </nav>
        <div className="settings-stack">
          <SettingsSection def={def("serviceHours")} change={change("serviceHours")} readOnly={ro}>
            <ServiceHoursCard />
          </SettingsSection>
          <SettingsSection def={def("dispatch")} change={change("dispatch")} readOnly={ro}>
            <RideRequestsCard />
            <OfferSecondsLine />
          </SettingsSection>
          <SettingsSection def={def("pricing")} change={change("pricing")} readOnly={ro}>
            <PricesCard />
            <WaitFeeCard />
            <FarPricingCard />
          </SettingsSection>
          <SettingsSection def={def("scheduled")} change={change("scheduled")} readOnly={ro}>
            <ScheduleSettingsCard />
          </SettingsSection>
          <SettingsSection def={def("commission")} change={change("commission")} readOnly={ro}>
            <CommissionTermsCard readOnly={ro} />
            <CommissionRulesCard />
          </SettingsSection>
          <SettingsSection def={def("notifications")} change={change("notifications")} readOnly={ro}>
            <SettingsScreen />
            <p className="muted small">
              To send a push notification to riders, drivers or one number, use <Link to="/notifications">Notifications</Link>.
            </p>
          </SettingsSection>
          <SettingsSection def={def("admins")} change={change("admins")} readOnly={ro}>
            <PasskeysCard />
            {ro ? (
              <p className="muted">Admin sign-ins are hidden in investor view.</p>
            ) : (
              <div className="inset">
                <h3>Recent admin sign-ins</h3>
                <span id="logins" />
                <AdminLoginsScreen />
              </div>
            )}
            <div className="inset">
              <h3>About this system</h3>
              <SystemFacts />
            </div>
          </SettingsSection>
        </div>
      </div>
    </Page>
  );
}
