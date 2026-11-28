import { lazy, Suspense, useCallback, useEffect } from "react";
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
import { InvestorViewProvider, useInvestorView } from "./lib/useInvestorView";
import { MOVED } from "./shell/nav";

// Pages other than the Overview load when first opened, so the first
// screen arrives quickly on a phone.
const LiveMapPage = lazy(() => import("./pages/LiveMap").then((m) => ({ default: m.LiveMapPage })));
const RidesPage = lazy(() => import("./pages/Rides").then((m) => ({ default: m.RidesPage })));
const SupplyPage = lazy(() => import("./pages/SupplyDemand").then((m) => ({ default: m.SupplyDemandPage })));
const CancellationsPage = lazy(() => import("./pages/Cancellations").then((m) => ({ default: m.CancellationsPage })));
const DriversPage = lazy(() => import("./pages/Drivers").then((m) => ({ default: m.DriversPage })));
const MoneyPage = lazy(() => import("./pages/Money").then((m) => ({ default: m.MoneyPage })));
const PricingPage = lazy(() => import("./pages/Pricing").then((m) => ({ default: m.PricingPage })));
const AuditPage = lazy(() => import("./pages/Audit").then((m) => ({ default: m.AuditPage })));
const RidersPage = lazy(() => import("./pages/Riders").then((m) => ({ default: m.RidersPage })));
const PlacesPage = lazy(() => import("./pages/Places").then((m) => ({ default: m.PlacesPage })));
const ScheduledPage = lazy(() => import("./pages/Scheduled").then((m) => ({ default: m.ScheduledPage })));
const SafetyPage = lazy(() => import("./pages/Safety").then((m) => ({ default: m.SafetyPage })));
const NotificationsPage = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.NotificationsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));

/** An old address that moved (/cash → /money), keeping its query. */
function Moved({ to }: { to: string }) {
  const { search, navigate } = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(search);
    // The old Finances page is the Commission tab now.
    if (to === "/money" && !params.has("tab")) params.set("tab", "commission");
    const q = params.toString();
    navigate(`${to}${q ? `?${q}` : ""}`, { replace: true });
  }, [to, search, navigate]);
  return null;
}

function Routes() {
  const { path } = useRouter();
  if (MOVED[path]) return <Moved to={MOVED[path]} />;
  switch (path) {
    case "/":
      return <OverviewPage />;
    case "/live":
      return <LiveMapPage />;
    case "/rides":
      return <RidesPage />;
    case "/scheduled":
      return <ScheduledPage />;
    case "/supply":
      return <SupplyPage />;
    case "/cancellations":
      return <CancellationsPage />;
    case "/drivers":
      return <DriversPage />;
    case "/money":
      return <MoneyPage />;
    case "/pricing":
      return <PricingPage />;
    case "/audit":
      return <AuditPage />;
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
    <InvestorViewProvider>
      <RouterProvider>
        <ToastProvider>
          <Pages />
        </ToastProvider>
      </RouterProvider>
    </InvestorViewProvider>
  );
}

/** The shell and pages, remounted when investor view switches so every page fetches again (masked or not). */
function Pages() {
  const { on } = useInvestorView();
  return (
    <Shell key={on ? "investor" : "normal"}>
      <Suspense fallback={<Loading />}>
        <Routes />
        <DetailLayer />
      </Suspense>
    </Shell>
  );
}
