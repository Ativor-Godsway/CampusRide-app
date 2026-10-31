import { useState } from "react";
import { ApiError, getRiderDetail, setEarlyAccess } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { DetailDrawer } from "../components/DetailDrawer";
import { Loaded } from "../components/States";
import { useToast } from "../components/Toast";
import { Link, useRouter, withParams } from "../lib/router";
import { dayAndTime, shortDay } from "../lib/time";
import { usePolled } from "../lib/usePolled";
import { DeleteAccountScreen } from "../screens/DeleteAccountScreen";
import { RateLimitsScreen } from "../screens/RateLimitsScreen";
import { rideColumns } from "./rideColumns";

/** One rider in full (their whole phone number is shown only here). */
export function RiderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const token = useToken();
  const toast = useToast();
  const { path, search, navigate } = useRouter();
  const detail = usePolled(() => getRiderDetail(token, id), `rider:${id}`);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<"limits" | "delete" | null>(null);
  const r = detail.data?.rider;

  const toggleEarly = async () => {
    if (!r?.phone) return;
    setBusy(true);
    try {
      await setEarlyAccess(token, r.phone, !r.earlyAccessAt);
      toast(r.earlyAccessAt ? "Early access taken away" : "Early access given");
      detail.refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailDrawer title={r?.name ?? "Rider"} subtitle={r ? `Rider since ${shortDay(r.joinedAt)}` : undefined} onClose={onClose} wide>
      <Loaded {...detail} onRetry={detail.refresh} what="Loading the rider…">
        {(d) => (
          <div className="detail-stack">
            <dl className="facts">
              <div>
                <dt>Phone</dt>
                <dd className="num">{d.rider.phone ?? "Account closed"}</dd>
              </div>
              <div>
                <dt>Rides</dt>
                <dd>
                  {d.stats.completed} completed · {d.stats.requests} asked for · {d.stats.cancelled} cancelled by them
                </dd>
              </div>
              <div>
                <dt>Emergency contact</dt>
                <dd>{d.rider.hasEmergencyContact ? "Saved" : "None saved"}</dd>
              </div>
              <div>
                <dt>Early access</dt>
                <dd>
                  {d.rider.earlyAccessAt ? <Chip tone="green">Since {shortDay(d.rider.earlyAccessAt)}</Chip> : <span className="muted">No</span>}{" "}
                  {d.rider.phone ? (
                    <button type="button" className="text-button small" disabled={busy} onClick={() => void toggleEarly()}>
                      {d.rider.earlyAccessAt ? "Take away" : "Give early access"}
                    </button>
                  ) : null}
                </dd>
              </div>
            </dl>

            <h3>Rides</h3>
            <DataTable columns={rideColumns({ compact: "rider" })} rows={d.rides} rowKey={(x) => x.id} onRowClick={(x) => navigate(withParams(path, search, { rider: null, ride: x.id }))} rowLabel={(x) => `Open ride ${x.pickup} to ${x.dropoff}`} empty="No rides yet." pageSize={10} />

            <h3>Ratings given</h3>
            {d.ratingsGiven.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="plain-list">
                {d.ratingsGiven.map((rt, i) => (
                  <li key={i}>
                    <span className="stars" aria-label={`${rt.stars} out of 5 stars`}>
                      {"★".repeat(rt.stars)}
                      <span className="stars-off">{"★".repeat(5 - rt.stars)}</span>
                    </span>{" "}
                    for {rt.ratee.name} · <Link to={withParams(path, search, { rider: null, ride: rt.rideId })}>{shortDay(rt.createdAt)}</Link>
                    {rt.comment ? <q className="muted"> {rt.comment}</q> : null}
                  </li>
                ))}
              </ul>
            )}

            <h3>SOS</h3>
            {d.sos.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="plain-list">
                {d.sos.map((s) => (
                  <li key={s.id}>
                    <Chip tone={s.handledAt ? "neutral" : "red"}>{s.handledAt ? "Handled" : "Open"}</Chip> {dayAndTime(s.createdAt)} · <Link to="/safety">Safety</Link>
                  </li>
                ))}
              </ul>
            )}

            {d.rider.phone ? (
              <>
                <h3>Account tools</h3>
                <div className="button-row">
                  <button type="button" className={tool === "limits" ? "tonal-button active" : "tonal-button"} aria-expanded={tool === "limits"} onClick={() => setTool(tool === "limits" ? null : "limits")}>
                    Rate limits
                  </button>
                  <button type="button" className={tool === "delete" ? "tonal-button active" : "tonal-button"} aria-expanded={tool === "delete"} onClick={() => setTool(tool === "delete" ? null : "delete")}>
                    Delete account…
                  </button>
                </div>
                {tool === "limits" ? <RateLimitsScreen phone={d.rider.phone} embedded /> : null}
                {tool === "delete" ? <DeleteAccountScreen phone={d.rider.phone} /> : null}
              </>
            ) : null}
          </div>
        )}
      </Loaded>
    </DetailDrawer>
  );
}
