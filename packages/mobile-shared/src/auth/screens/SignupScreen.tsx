import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import { useAuth } from "../AuthContext";
import { Button, Screen, Text, Input, colors, radii, spacing, touchTarget } from "../../design";
import { errorMessage } from "../errorMessage";

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
    <Screen edges={["top", "bottom"]} style={styles.container}>
      <Text variant="h1" style={styles.title}>
        Tell us about you
      </Text>

      <Input placeholder="Full name" autoComplete="name" value={name} onChangeText={setName} />

      {allowedRoles.length > 1 ? (
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
      ) : null}

      {error ? (
        <Text variant="bodySmall" color="error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Button label="Finish" loading={isSubmitting} onPress={() => void handleSubmit()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
  },
  title: {
    marginBottom: spacing.xl,
    textAlign: "center",
  },
  roleRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  roleButton: {
    flex: 1,
    borderWidth: 1,
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
