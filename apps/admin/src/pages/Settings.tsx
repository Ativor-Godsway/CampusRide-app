import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ADMIN_SAVED_EVENT,
  getAdmins,
  getCommissionSettings,
  getCommissionTerms,
  getDispatchSettings,
  getFarPricing,
  getLaunchSettings,
  getScheduleSettings,
  getServiceHours,
  getSettingsChanges,
  getSystem,
  getWaitFeeSettings,
  priceSettingsOf,
  renameAdmin,
  ApiError,
  failureText,
  type AdminAccount,
  type SettingsSectionKey,
} from "../api";
import { useAuth, useToken } from "../auth";
import { Chip } from "../components/Chip";
import { Collapsible } from "../components/Collapsible";
import { ConfirmSubmit } from "../components/ConfirmSubmit";
import { Loaded } from "../components/States";
import { useToast } from "../components/Toast";
import { cedis } from "../lib/money";
import { usePolled } from "../lib/usePolled";
import { useInvestorView } from "../lib/useInvestorView";
import { dayAndTime, ago } from "../lib/time";
import { Link, useRouter } from "../lib/router";
import { AdminLoginsScreen } from "../screens/AdminLoginsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { CommissionRulesCard } from "../screens/CommissionRulesCard";
import { RideRequestsCard } from "../screens/RideRequestsCard";
import { WaitFeeCard } from "../screens/WaitFeeCard";
import { ScheduleSettingsCard } from "../screens/ScheduleSettingsCard";
import { PricesCard } from "../screens/PricesCard";
import { FarPricingCard } from "../screens/FarPricingCard";
import { PasskeysCard } from "../screens/PasskeysCard";
import { ServiceHoursCard, todayHoursLine, weekLine } from "../screens/ServiceHoursCard";
import { InvestorSwitch, Page, Section } from "../shell/Page";
import { CommissionTermsCard, ratePercent } from "./Money";

type SectionId = "service-hours" | "dispatch" | "pricing" | "scheduled" | "commission" | "notifications" | "display" | "admins";

interface SectionDef {
  id: SectionId;
  /** The audit actions behind "Last changed by …" (none for Display). */
  key: SettingsSectionKey | null;
  title: string;
  help: string;
}

/** The Settings sections, in order: plain-English titles and what each controls. */
export const SETTINGS_SECTIONS: SectionDef[] = [
  { id: "service-hours", key: "serviceHours", title: "Service hours", help: "When riders can book. Outside these hours the apps say when CampusRide opens." },
  { id: "dispatch", key: "dispatch", title: "Dispatch", help: "How a request finds a driver: how long it searches, the drivers' pop-up, and filling cars already on a trip first." },
  { id: "pricing", key: "pricing", title: "Pricing", help: "What riders pay: Shared seats, far trips, Ride alone and the pickup wait fee." },
  { id: "scheduled", key: "scheduled", title: "Scheduled rides", help: "Booking a Shared ride ahead: slots, when cars go to drivers, reminders and late cancels." },
  { id: "commission", key: "commission", title: "Commission", help: "CampusRide's share of each completed fare, the waiver, and when a driver who owes too much is stopped." },
  { id: "notifications", key: "notifications", title: "Notifications & launch", help: "Launch mode and early access, and the one-time launch push." },
  { id: "display", key: null, title: "Display", help: "How this site shows things on your screen." },
  { id: "admins", key: "admins", title: "Admin users", help: "Who can sign in to this site, their names, passkeys and recent sign-ins." },
];

/** "Last changed by Ama · Today 09:14", or "Not changed yet". */
export function lastChangedLine(change: { at: string; by: string } | null | undefined, now: number = Date.now()): string {
  if (!change) return "Not changed yet: the defaults apply";
  return `Last changed by ${change.by} · ${dayAndTime(change.at, now)}`;
}

/** "7 min", "1 min 30 s". */
function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Loads a summary's data once (and again after a save). */
function useSummary<T>(load: () => Promise<T>, version: number): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && setData(d),
      (err) => live && setError(failureText("Loading the current settings", err)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return { data, error };
}

function Summary({ rows, error }: { rows: Array<[string, ReactNode]> | null; error: string | null }) {
  if (error) return <p className="error-text">{error}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <dl className="summary-list">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function onOff(b: boolean | undefined): string {
  return b ? "On" : "Off";
}

/** The current values of a section, in plain words. */
function SectionSummary({ id, version }: { id: SectionId; version: number }) {
  const token = useToken();
  const loaders: Record<SectionId, () => Promise<Array<[string, ReactNode]>>> = {
    "service-hours": async () => {
      const h = await getServiceHours(token);
      return [
        ["Now", h.stateLine],
        ["Today", todayHoursLine(h.setting.weekly).replace(/^Today /, "")],
        ["Every week", weekLine(h.setting.weekly)],
        ["No drivers online", h.setting.blockWhenNoDrivers ? "Riders are asked to try again shortly" : "Riders can still request"],
        ["Message while closed", h.setting.closedMessage ?? "None"],
      ];
    },
    dispatch: async () => {
      const d = await getDispatchSettings(token);
      return [
        ["A request searches for", minutes(d.settings.searchWindowSeconds)],
        ["Each driver's pop-up", d.offerSeconds ? `${d.offerSeconds} seconds (set on the server)` : "Set on the server"],
        ["Fill moving cars first", onOff(d.settings.movingFirstEnabled)],
        ["Auto-add riders, by default", `${onOff(d.settings.autoAddDefault)} (drivers who never chose get the 20 s "On your way" offer)`],
      ];
    },
    pricing: async () => {
      const [f, w] = await Promise.all([getFarPricing(token), getWaitFeeSettings(token)]);
      const p = priceSettingsOf(f);
      const north = f.farPlaces.filter((x) => x.end === "NORTH").length;
      const south = f.farPlaces.length - north;
      return [
        ["Shared", `${cedis(p.sharedPesewas)} · 2 seats ${cedis(p.shared2Pesewas)} · 3 seats ${cedis(p.shared3Pesewas)}`],
        ["Far trip", `+${cedis(p.farPerSeatPesewas)} a seat between the ends (${north} north, ${south} south places)`],
        ["Ride alone", `${cedis(p.lonePesewas)} for the whole car`],
        ["Wait fee", w.settings.feePesewas ? `${cedis(w.settings.feePesewas)} after ${minutes(w.settings.freeWaitSeconds)} free; no-show after ${w.settings.noShowMinutes} min` : "None"],
      ];
    },
    scheduled: async () => {
      const s = (await getScheduleSettings(token)).settings;
      return [
        ["Riders can book ahead", onOff(s.enabled)],
        ['"Book your ride ahead" intro', onOff(s.introEnabled)],
        ["Slots", `Every ${s.slotMinutes} min, booking closes ${s.bookingCutoffMinutes} min before`],
        ["Offered to drivers", `At ${s.offerNowSeats}+ seats straight away; ${s.offerLaterSeats}+ seats ${s.offerLaterMinutes} min before`],
        ["Free cancel", `Up to ${s.freeCancelMinutes} min before; ${s.strikesToBlock} late cancels or no-shows block for ${s.blockDays} days`],
      ];
    },
    commission: async () => {
      const [t, r] = await Promise.all([getCommissionTerms(token), getCommissionSettings(token)]);
      return [
        ["Commission rate", `${ratePercent(t.terms.rateBps)} of each completed fare`],
        ["Commission waived", t.terms.waived ? `On, from ${t.terms.waivedFromDay ?? "the start"}: drivers owe nothing` : "Off: charged automatically"],
        ["Stop drivers who owe", r.settings.enforcementEnabled ? `On, at ${cedis(r.settings.debtLimitPesewas)} (warning at ${r.settings.warningPercent}%)` : "Off"],
        ["Paystack fee", `${(r.settings.feeBps / 100).toFixed(2)}%${r.settings.feeCapPesewas ? `, at most ${cedis(r.settings.feeCapPesewas)}` : ""}, added for the driver`],
      ];
    },
    notifications: async () => {
      const l = await getLaunchSettings(token);
      return [
        ["Launch mode", l.setting.mode === "OFF" ? "Off: everyone can ride" : l.setting.mode === "LIVE" ? "Live: everyone can ride" : `Countdown to ${l.setting.launchAt ? dayAndTime(l.setting.launchAt) : "—"}`],
        ["Riders with early access", String(l.earlyAccessRiders)],
        ["Push notifications", <Link key="n" to="/notifications">Send one on Notifications</Link>],
      ];
    },
    display: async () => [],
    admins: async () => [],
  };
  const summary = useSummary(loaders[id], version);
  return <Summary rows={summary.data} error={summary.error} />;
}

/** The editors behind each section's Edit (the cards that save). */
function SectionEditor({ id }: { id: SectionId }) {
  switch (id) {
    case "service-hours":
      return <ServiceHoursCard />;
    case "dispatch":
      return <RideRequestsCard />;
    case "pricing":
      return (
        <>
          <h3>Prices</h3>
          <PricesCard />
          <h3>Far-trip places</h3>
          <FarPricingCard />
          <h3>Pickup wait fee</h3>
          <WaitFeeCard />
        </>
      );
    case "scheduled":
      return <ScheduleSettingsCard />;
    case "commission":
      return (
        <>
          <CommissionTermsCard />
          <CommissionRulesCard />
        </>
      );
    case "notifications":
      return <SettingsScreen />;
    default:
      return null;
  }
}

/** A section: its current values in plain words, Edit to change them (each save asks first), then "Saved" and who changed it. */
function EditableSection({ def, change, readOnly, onSaved }: { def: SectionDef; change: { at: string; by: string } | null | undefined; readOnly: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!editing) return;
    const onSave = () => {
      setSaved(true);
      setVersion((v) => v + 1);
      onSaved();
      toast(`${def.title} saved`);
    };
    window.addEventListener(ADMIN_SAVED_EVENT, onSave);
    return () => window.removeEventListener(ADMIN_SAVED_EVENT, onSave);
  }, [editing, def.title, onSaved, toast]);

  return (
    <Section
      className="settings-section"
      title={<span id={def.id}>{def.title}</span>}
      actions={
        readOnly ? (
          <span className="section-meta">Read-only in investor view</span>
        ) : editing ? (
          <button
            type="button"
            className="tonal-button"
            onClick={() => {
              setEditing(false);
              setVersion((v) => v + 1);
            }}
          >
            {saved ? "Done" : "Cancel"}
          </button>
        ) : (
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )
      }
    >
      <p className="section-help">{def.help}</p>
      {editing ? (
        <ConfirmSubmit what={def.title.toLowerCase()}>
          <div className="stack">
            <SectionEditor id={def.id} />
          </div>
        </ConfirmSubmit>
      ) : (
        <SectionSummary id={def.id} version={version} />
      )}
      {editing && !saved ? null : (
        <p className={saved ? "saved-note" : "section-meta"}>
          {saved ? "✓ Saved. " : ""}
          {readOnly ? "" : lastChangedLine(change)}
        </p>
      )}
    </Section>
  );
}

/** Admin users: everyone who can sign in here; change a display name (yours too). */
function AdminAccounts({ readOnly }: { readOnly: boolean }) {
  const token = useToken();
  const toast = useToast();
  const { session, signIn } = useAuth();
  const list = usePolled(() => getAdmins(token), "admins", undefined, "Loading the admin accounts");
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const { admin } = await renameAdmin(token, editing.id, name);
      if (editing.isMe && session) signIn({ ...session, user: { ...session.user, name: admin.name } });
      toast(editing.isMe ? `Your name is now ${admin.name}` : `Renamed to ${admin.name}`);
      setEditing(null);
      list.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving the name", err) : "Saving failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Loaded {...list} onRetry={list.refresh}>
      {(l) => (
        <table className="hours-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Phone</th>
              <th scope="col">Admin since</th>
              <th scope="col">
                <span className="sr-only">Edit</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {l.admins.map((a) => (
              <tr key={a.id}>
                <td>
                  {editing?.id === a.id ? (
                    <form className="inline-search" onSubmit={(e) => void save(e)}>
                      <input aria-label="Display name" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
                      <button type="submit" className="primary-button" disabled={busy || name.trim().length < 2}>
                        Save
                      </button>
                      <button type="button" className="text-button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <strong>{a.name}</strong> {a.isMe ? <Chip tone="green">You</Chip> : null}
                    </>
                  )}
                  {editing?.id === a.id && error ? <p className="error-text">{error}</p> : null}
                </td>
                <td className="num muted">{a.maskedPhone ?? "—"}</td>
                <td className="muted">{dayAndTime(a.joinedAt)}</td>
                <td>
                  {readOnly || editing?.id === a.id ? null : (
                    <button
                      type="button"
                      className="text-button small"
                      onClick={() => {
                        setEditing(a);
                        setName(a.name);
                        setError(null);
                      }}
                    >
                      {a.isMe ? "Change my name" : "Change name"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Loaded>
  );
}

function SystemFacts() {
  const token = useToken();
  const sys = usePolled(() => getSystem(token), "system", undefined, "Loading system facts");
  return (
    <Loaded {...sys} onRetry={sys.refresh}>
      {(s) => (
        <dl className="summary-list">
          <dt>Review demo mode</dt>
          <dd>
            {s.reviewDemo.enabled ? "On" : "Off"}
            {s.reviewDemo.problems.length ? <span className="muted"> · switched on but not working: {s.reviewDemo.problems.join("; ")}</span> : null}
          </dd>
          {(["rider", "driver"] as const).map((app) => (
            <div key={app} style={{ display: "contents" }}>
              <dt>{app === "rider" ? "Rider app" : "Driver app"} minimum version</dt>
              <dd>
                iPhone {s.minVersions[app]?.ios?.minVersion ?? "none"} · Android {s.minVersions[app]?.android?.minVersion ?? "none"}
              </dd>
            </div>
          ))}
          <dt>Server version</dt>
          <dd className="num">{s.server.commit ?? "not known (not built on Render)"}</dd>
          <dt>Last deploy or restart</dt>
          <dd>
            {dayAndTime(s.server.startedAt)} <span className="muted">({ago(s.server.startedAt)})</span>
          </dd>
        </dl>
      )}
    </Loaded>
  );
}

function isSection(v: string): v is SectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === v);
}

/**
 * Settings: a clean list of sections on the left, one section at a time on
 * the right. Each shows its current values in plain words; Edit opens the
 * form, every save asks first, then says "Saved" and who changed it last.
 * In investor view everything is read-only and who changed what is hidden.
 */
export function SettingsPage() {
  const token = useToken();
  const investor = useInvestorView();
  const { search, setParams } = useRouter();
  const changes = usePolled(() => getSettingsChanges(token), "settings-changes", undefined, "Loading when settings changed");
  const fromHash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
  const param = search.get("section") ?? fromHash;
  const active: SectionId = isSection(param) ? param : "service-hours";
  const def = SETTINGS_SECTIONS.find((s) => s.id === active)!;
  const ro = investor.on;
  const refreshChanges = changes.refresh;
  const onSaved = useCallback(() => window.setTimeout(refreshChanges, 400), [refreshChanges]);
  const change = def.key ? (changes.data?.sections[def.key] ?? null) : null;

  return (
    <Page title="Settings" subtitle="Each section saves on its own, and every change is written to the audit log.">
      <div className="settings-layout">
        <nav className="settings-index" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`/settings?section=${s.id}`}
              className={active === s.id ? "active" : undefined}
              aria-current={active === s.id ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
                setParams({ section: s.id }, { replace: true });
              }}
            >
              {s.title}
            </a>
          ))}
        </nav>
        <div className="settings-stack" key={active}>
          {active === "display" ? (
            <Section className="settings-section" title={<span id="display">Display</span>}>
              <p className="section-help">{def.help}</p>
              <InvestorSwitch />
            </Section>
          ) : active === "admins" ? (
            <>
              <Section className="settings-section" title={<span id="admins">Admin users</span>} actions={<span className="section-meta">{ro ? "" : lastChangedLine(change)}</span>}>
                <p className="section-help">{def.help}</p>
                <AdminAccounts readOnly={ro} />
              </Section>
              <fieldset className="read-only" disabled={ro}>
                <Collapsible id="settings.passkeys" title="Passkeys" hint="Sign in to this site with Face ID or Touch ID instead of a phone code.">
                  <PasskeysCard />
                </Collapsible>
              </fieldset>
              {ro ? null : (
                <Collapsible id="settings.logins" title="Recent admin sign-ins" hint="Every sign-in to this site: who, when, from where. Spot one you don't recognise.">
                  <AdminLoginsScreen />
                </Collapsible>
              )}
              <Collapsible id="settings.system" title="About this system" hint="App minimum versions, the server's version and when it last restarted.">
                <SystemFacts />
              </Collapsible>
            </>
          ) : (
            <EditableSection def={def} change={change} readOnly={ro} onSaved={onSaved} />
          )}
        </div>
      </div>
    </Page>
  );
}
