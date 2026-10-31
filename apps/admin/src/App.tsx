import { lazy, Suspense, useCallback } from "react";
import { useAuth } from "./auth";
import { LoginScreen } from "./screens/LoginScreen";
import { Loading } from "./components/States";
import { ToastProvider } from "./components/Toast";
import { RouterProvider, useRouter, withParams } from "./lib/router";
import { MorePage, Shell } from "./shell/Shell";
import { OverviewPage } from "./pages/Overview";
import { RideDetail } from "./pages/RideDetail";
import { DriverDetail } from "./pages/DriverDetail";
import { RiderDetail } from "./pages/RiderDetail";

// Pages other than the Overview load when first opened, so the first
// screen arrives quickly on a phone.
const LiveMapPage = lazy(() => import("./pages/LiveMap").then((m) => ({ default: m.LiveMapPage })));
const RidesPage = lazy(() => import("./pages/Rides").then((m) => ({ default: m.RidesPage })));
const SupplyPage = lazy(() => import("./pages/SupplyDemand").then((m) => ({ default: m.SupplyDemandPage })));
const CancellationsPage = lazy(() => import("./pages/Cancellations").then((m) => ({ default: m.CancellationsPage })));
const DriversPage = lazy(() => import("./pages/Drivers").then((m) => ({ default: m.DriversPage })));
const CashPage = lazy(() => import("./pages/CashOwed").then((m) => ({ default: m.CashOwedPage })));
const RidersPage = lazy(() => import("./pages/Riders").then((m) => ({ default: m.RidersPage })));
const PlacesPage = lazy(() => import("./pages/Places").then((m) => ({ default: m.PlacesPage })));
const SafetyPage = lazy(() => import("./pages/Safety").then((m) => ({ default: m.SafetyPage })));
const NotificationsPage = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.NotificationsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));

function Routes() {
  const { path } = useRouter();
  switch (path) {
    case "/":
      return <OverviewPage />;
    case "/live":
      return <LiveMapPage />;
    case "/rides":
      return <RidesPage />;
    case "/supply":
      return <SupplyPage />;
    case "/cancellations":
      return <CancellationsPage />;
    case "/drivers":
      return <DriversPage />;
    case "/cash":
      return <CashPage />;
    case "/riders":
      return <RidersPage />;
    case "/places":
      return <PlacesPage />;
    case "/safety":
      return <SafetyPage />;
    case "/notifications":
      return <NotificationsPage />;
    case "/settings":
      return <SettingsPage />;
    case "/more":
      return <MorePage />;
    default:
      return (
        <div className="page">
          <h1>Page not found</h1>
          <p className="muted">There is no page at {path}. Pick one from the menu.</p>
        </div>
      );
  }
}

/** A ride, driver or rider panel over whatever page is open (?ride=, ?driver=, ?rider=). */
function DetailLayer() {
  const { path, search, navigate } = useRouter();
  const ride = search.get("ride");
  const driver = search.get("driver");
  const rider = search.get("rider");
  const close = useCallback(
    (key: string) => navigate(withParams(path, search, { [key]: null })),
    [navigate, path, search],
  );
  if (ride) return <RideDetail id={ride} onClose={() => close("ride")} />;
  if (driver) return <DriverDetail id={driver} onClose={() => close("driver")} />;
  if (rider) return <RiderDetail id={rider} onClose={() => close("rider")} />;
  return null;
}

/**
 * The admin site: the login gate, then the shell (sidebar or tab bar) with
 * one page per URL. Every page is deep-linkable; back and forward work.
 */
export function App() {
  const { session } = useAuth();
  if (!session) return <LoginScreen />;
  return (
    <RouterProvider>
      <ToastProvider>
        <Shell>
          <Suspense fallback={<Loading />}>
            <Routes />
            <DetailLayer />
          </Suspense>
        </Shell>
      </ToastProvider>
    </RouterProvider>
  );
}
