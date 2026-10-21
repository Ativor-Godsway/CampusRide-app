import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { Button, useAuth } from "@rida/mobile-shared";

/**
 * The way out of onboarding and the waiting screen: confirms, clears the
 * stored session on this phone, and returns to the phone-number screen.
 */
export function useSignOutToPhone() {
  const router = useRouter();
  const { signOut } = useAuth();

  return () =>
    Alert.alert(
      "Use a different number?",
      "You'll be logged out on this phone. Anything you haven't submitted yet will be lost.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log out",
          style: "destructive",
          onPress: () => {
            void signOut().then(() => router.replace("/auth/welcome"));
          },
        },
      ],
    );
}

/** "Use a different number": the ONE way out, at the bottom of onboarding and the waiting screen. */
export function SignOutLink() {
  const confirmSignOut = useSignOutToPhone();
  return (
    <Button
      label="Use a different number"
      variant="text"
      onPress={confirmSignOut}
      accessibilityHint="Logs you out on this phone"
    />
  );
}
