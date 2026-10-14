import { useRouter } from "expo-router";
import { NotificationPermissionScreen } from "@rida/mobile-shared";

/** Shown once after login and approval (and from Account › Notifications): why, then the system prompt. */
export default function NotificationsScreen() {
  const router = useRouter();
  return (
    <NotificationPermissionScreen
      app="driver"
      reasons={[
        {
          icon: "car-outline",
          text: "Get new ride requests near you, even when the app is closed",
        },
        { icon: "close-circle-outline", text: "Know straight away if a rider cancels" },
      ]}
      onDone={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))}
    />
  );
}
