import { useCallback, useEffect, useState } from "react";
import { ApiError, getRides, type AdminRide } from "../api";
import { useAuth, useToken } from "../auth";

const STATUSES = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "AWAITING_RIDER_DECISION",
];

/** Fares are stored as integer pesewas; GHS 5.00 is 500. Never parse as a float. */
function formatFare(pesewas: number | null): string {
  if (pesewas === null) return "—";
  return `GHS ${(pesewas / 100).toFixed(2)}`;
}

/** Read-only oversight list. v1 filters: status and a createdAt window. */
export function RideList() {
  const token = useToken();
  const { signOut } = useAuth();
  const [rides, setRides] = useState<AdminRide[]>([]);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { rides: rows } = await getRides(token, { status, from, to });
      setRides(rows);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        signOut();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not load rides");
    } finally {
      setLoading(false);
    }
  }, [token, status, from, to, signOut]);

  // Load once on mount; afterwards the operator applies filters explicitly so
  // typing a date doesn't fire a request per keystroke.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section>
      <div className="section-head">
        <h2>Rides</h2>
      </div>

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <div>
          <label htmlFor="status">Status</label>
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from">From</label>
          <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="to">To</label>
          <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? "Loading…" : "Apply"}
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}

      {rides.length === 0 && !loading ? (
        <p className="muted">No rides match these filters.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Status</th>
                <th>Type</th>
                <th>Rider</th>
                <th>Driver</th>
                <th>Route</th>
                <th>Fare</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {rides.map((ride) => (
                <tr key={ride.id}>
                  <td>{new Date(ride.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`badge badge-${ride.status.toLowerCase()}`}>{ride.status}</span>
                  </td>
                  <td>
                    {ride.type}
                    {ride.type === "SHARED" ? ` (${ride.occupancy})` : ""}
                  </td>
                  <td>{ride.rider ? `${ride.rider.name} · ${ride.rider.phone}` : "—"}</td>
                  <td>{ride.driver ? `${ride.driver.name} · ${ride.driver.phone}` : "—"}</td>
                  <td>
                    {ride.pickupZone?.name ?? "?"} → {ride.dropoffZone?.name ?? "?"}
                  </td>
                  <td>{formatFare(ride.fareTotal)}</td>
                  <td>
                    {ride.paymentMethod} · {ride.paymentStatus}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
