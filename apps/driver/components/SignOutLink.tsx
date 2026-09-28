import { Alert, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Text, colors, spacing, useAuth } from "@rida/mobile-shared";

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
            void signOut().then(() => router.replace("/auth/phone"));
          },
        },
      ],
    );
}

export interface SignOutLinkProps {
  /** "compact" is the small top-bar button; "full" the sentence-length link. */
  variant?: "compact" | "full";
}

export function SignOutLink({ variant = "full" }: SignOutLinkProps) {
  const confirmSignOut = useSignOutToPhone();
  const compact = variant === "compact";

  return (
    <Pressable
      onPress={confirmSignOut}
      accessibilityRole="button"
      accessibilityLabel="Use a different number or log out"
      hitSlop={8}
      style={({ pressed }) => [styles.row, compact && styles.compact, pressed && styles.pressed]}
    >
      <Ionicons name="log-out-outline" size={compact ? 16 : 18} color={colors.ink[600]} />
      <Text variant={compact ? "caption" : "bodySmall"} style={styles.label}>
        {compact ? "Log out" : "Use a different number / Log out"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.md,
  },
  compact: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.surfaceMuted,
  },
  pressed: { opacity: 0.6 },
  label: { color: colors.ink[600], fontWeight: "600" },
});
