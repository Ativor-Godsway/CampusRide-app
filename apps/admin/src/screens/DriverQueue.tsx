import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  approveDriver,
  getPendingDrivers,
  rejectDriver,
  type PendingDriver,
} from "../api";
import { useAuth, useToken } from "../auth";

/**
 * The primary screen: every driver sitting at isApproved=false, with enough
 * submitted detail to make the call, and the two decisions.
 *
 * A reject asks for a reason before it will submit. It is optional in the API
 * (some rejections are obvious) but the audit log is worth much more with one,
 * and the moment to capture it is while the admin is looking at the row.
 */
export function DriverQueue() {
  const token = useToken();
  const { signOut } = useAuth();
  const [drivers, setDrivers] = useState<PendingDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { drivers: rows } = await getPendingDrivers(token);
      setDrivers(rows);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        signOut();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not load the queue");
    } finally {
      setLoading(false);
    }
  }, [token, signOut]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(driverId: string, action: "approve" | "reject") {
    setBusyId(driverId);
    setError(null);
    try {
      if (action === "approve") {
        await approveDriver(token, driverId);
      } else {
        await rejectDriver(token, driverId, reason.trim());
      }
      // Approved drivers leave the queue; rejected ones stay (still
      // unapproved) but the reason is now on the record, so reload either way.
      setRejecting(null);
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The action failed");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p className="muted">Loading the approval queue…</p>;

  return (
    <section>
      <div className="section-head">
        <h2>Driver approvals</h2>
        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {drivers.length === 0 ? (
        <p className="muted">No drivers are waiting for approval.</p>
      ) : (
        <ul className="driver-list">
          {drivers.map((driver) => (
            <li key={driver.id} className="card driver-card">
              {driver.photoUrl ? (
                <img className="photo" src={driver.photoUrl} alt={`${driver.user.name}'s vehicle`} />
              ) : (
                <div className="photo photo-missing">No photo</div>
              )}

              <div className="driver-detail">
                <h3>{driver.user.name}</h3>
                <p className="muted">{driver.user.phone}</p>
                <dl>
                  <div>
                    <dt>Vehicle</dt>
                    <dd>
                      {[driver.carColor, driver.carMake, driver.carModel].filter(Boolean).join(" ") ||
                        "— not submitted —"}
                    </dd>
                  </div>
                  <div>
                    <dt>Plate</dt>
                    <dd>{driver.plate ?? "— not submitted —"}</dd>
                  </div>
                  <div>
                    <dt>Applied</dt>
                    <dd>{new Date(driver.createdAt).toLocaleString()}</dd>
                  </div>
                </dl>
              </div>

              <div className="driver-actions">
                {rejecting === driver.id ? (
                  <>
                    <label htmlFor={`reason-${driver.id}`}>Reason for rejection</label>
                    <textarea
                      id={`reason-${driver.id}`}
                      rows={3}
                      value={reason}
                      placeholder="e.g. Plate does not match the vehicle photo"
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <button
                      type="button"
                      className="danger"
                      disabled={busyId === driver.id || reason.trim().length === 0}
                      onClick={() => void act(driver.id, "reject")}
                    >
                      Confirm rejection
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setRejecting(null);
                        setReason("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busyId === driver.id}
                      onClick={() => void act(driver.id, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busyId === driver.id}
                      onClick={() => {
                        setRejecting(driver.id);
                        setReason("");
                      }}
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
