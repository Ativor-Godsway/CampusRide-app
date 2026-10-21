import { useRouter } from "expo-router";
import { NotificationPermissionScreen } from "@rida/mobile-shared";

/** Shown once after login (and from Account › Notifications): why, then the system prompt. */
export default function NotificationsScreen() {
  const router = useRouter();
  return (
    <NotificationPermissionScreen
      app="rider"
      backButton
      reasons={[
        {
          icon: "car-outline",
          text: "Know when your driver is on the way, and when they're at your pickup",
        },
        { icon: "flag-outline", text: "Hear when your trip starts and ends" },
        { icon: "alert-circle-outline", text: "Find out straight away if your ride changes" },
      ]}
      onDone={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))}
    />
  );
}
