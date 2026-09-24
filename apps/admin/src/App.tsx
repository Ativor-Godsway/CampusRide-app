import { useState } from "react";
import { useAuth } from "./auth";
import { LoginScreen } from "./screens/LoginScreen";
import { DriverQueue } from "./screens/DriverQueue";
import { RideList } from "./screens/RideList";

type Tab = "drivers" | "rides";

/**
 * Two screens behind one login gate. No router: adding one would buy
 * deep-linkable URLs for an internal tool that has exactly two views and is
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
        </nav>
        <div className="session">
          <span className="muted">{session.user.name}</span>
          <button type="button" className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main>{tab === "drivers" ? <DriverQueue /> : <RideList />}</main>
    </div>
  );
}
