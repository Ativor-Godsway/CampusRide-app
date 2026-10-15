import { useState } from "react";
import { useAuth } from "./auth";
import { LoginScreen } from "./screens/LoginScreen";
import { DriverQueue } from "./screens/DriverQueue";
import { RideList } from "./screens/RideList";
import { PlacesScreen } from "./screens/PlacesScreen";
import { RateLimitsScreen } from "./screens/RateLimitsScreen";
import { AdminLoginsScreen } from "./screens/AdminLoginsScreen";

type Tab = "drivers" | "rides" | "places" | "limits" | "logins";

/**
 * A few screens behind one login gate. No router: adding one would buy
 * deep-linkable URLs for an internal tool with a handful of views that is
 * never linked to from anywhere.
 */
export function App() {
  const { session, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>("drivers");

  if (!session) return <LoginScreen />;

  return (
    <div className="shell">
      <header>
        <div className="brand">CampusRide Admin</div>
        <nav>
          <button
            type="button"
            className={tab === "drivers" ? "tab active" : "tab"}
            onClick={() => setTab("drivers")}
          >
            Driver approvals
          </button>
          <button
            type="button"
            className={tab === "rides" ? "tab active" : "tab"}
            onClick={() => setTab("rides")}
          >
            Rides
          </button>
          <button
            type="button"
            className={tab === "places" ? "tab active" : "tab"}
            onClick={() => setTab("places")}
          >
            Places
          </button>
          <button
            type="button"
            className={tab === "limits" ? "tab active" : "tab"}
            onClick={() => setTab("limits")}
          >
            Rate limits
          </button>
          <button
            type="button"
            className={tab === "logins" ? "tab active" : "tab"}
            onClick={() => setTab("logins")}
          >
            Admin logins
          </button>
        </nav>
        <div className="session">
          <span className="muted">{session.user.name}</span>
          <button type="button" className="secondary" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main>
        {tab === "drivers" ? (
          <DriverQueue />
        ) : tab === "rides" ? (
          <RideList />
        ) : tab === "places" ? (
          <PlacesScreen />
        ) : tab === "limits" ? (
          <RateLimitsScreen />
        ) : (
          <AdminLoginsScreen />
        )}
      </main>
    </div>
  );
}
