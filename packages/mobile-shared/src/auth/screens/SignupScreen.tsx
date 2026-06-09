import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import { useAuth } from "../AuthContext";
import { Button, Screen, Text, Input, colors, radii, spacing, touchTarget } from "../../design";
import { errorMessage } from "../errorMessage";
import { AuthHero } from "./AuthHero";

type SignupRole = "RIDER" | "DRIVER";

export interface SignupScreenProps {
  /** Restrict the role picker — e.g. the driver app only ever signs up drivers. */
  allowedRoles?: SignupRole[];
}

/** Name + role entry — final step of signup, shared by both apps. */
export function SignupScreen({ allowedRoles = ["RIDER", "DRIVER"] }: SignupScreenProps) {
  const router = useRouter();
  const { completeSignup } = useAuth();
  const { phone, verifiedToken } = useLocalSearchParams<{ phone: string; verifiedToken: string }>();
  const [name, setName] = useState("");
  const [role, setRole] = useState<SignupRole>(allowedRoles[0] ?? "RIDER");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Enter your name");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await completeSignup({ phone, name: name.trim(), role, verifiedToken });
      router.replace("/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen scroll noPadding edges={["top"]}>
      <AuthHero compact title="Tell us about you" subtitle="One more step before you're ready to ride" onBack={() => router.back()} />
      <View style={styles.panel}>
        <Input label="Full name" placeholder="Full name" autoComplete="name" value={name} onChangeText={setName} />

        {allowedRoles.length > 1 ? (
          <View style={styles.roleSection}>
            <Text variant="label" color="muted" style={styles.roleLabel}>
              I am a...
            </Text>
            <View style={styles.roleRow}>
              {allowedRoles.map((option) => {
                const selected = role === option;
                return (
                  <Pressable
                    key={option}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[styles.roleButton, selected && styles.roleButtonSelected]}
                    onPress={() => setRole(option)}
                  >
                    <Text variant="bodyMedium" color={selected ? "inverse" : "default"}>
                      {option === "RIDER" ? "Rider" : "Driver"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {error ? (
          <Text variant="bodySmall" color="error" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <Button label="Finish" loading={isSubmitting} onPress={() => void handleSubmit()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
    marginTop: -radii["2xl"],
    paddingHorizontal: spacing.xl,
    paddingTop: spacing["2xl"],
    paddingBottom: spacing.xl,
  },
  roleSection: {
    marginBottom: spacing.lg,
  },
  roleLabel: {
    marginBottom: spacing.sm,
  },
  roleRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  roleButton: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radii.md,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
  },
  roleButtonSelected: {
    backgroundColor: colors.primary[500],
    borderColor: colors.primary[500],
  },
  error: {
    marginBottom: spacing.md,
    textAlign: "center",
  },
});
