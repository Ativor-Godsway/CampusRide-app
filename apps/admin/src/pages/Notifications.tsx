import { NotificationsScreen } from "../screens/NotificationsScreen";
import { Page } from "../shell/Page";

/** Notifications: the existing sender and history, in the new frame. No change in behaviour. */
export function NotificationsPage() {
  return (
    <Page title="Notifications" subtitle="Send a push notification to riders, drivers or one number">
      <NotificationsScreen />
    </Page>
  );
}
