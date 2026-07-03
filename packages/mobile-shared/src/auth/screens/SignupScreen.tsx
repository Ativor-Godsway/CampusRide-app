import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../AuthContext";
import {
  Button,
  Input,
  Screen,
  Text,
  border,
  brand,
  colors,
  radii,
  spacing,
  surface,
  touchTarget,
} from "../../design";
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
    <Screen scroll>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.backButton}
      >
        <Ionicons name="chevron-back" size={22} color={colors.ink[700]} />
      </Pressable>

      <Text variant="display">Tell us about you</Text>
      <Text variant="body" color="muted" style={styles.subtitle}>
        One more step before you're ready to ride.
      </Text>

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
                  <Text variant="bodyMedium" color={selected ? "primary" : "muted"}>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  backButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderColor: border.subtle,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  subtitle: {
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
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
    borderColor: border.subtle,
    borderRadius: radii.pill,
    backgroundColor: surface.raised,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
  },
  roleButtonSelected: {
    backgroundColor: brand.tint,
    borderColor: brand.primary,
  },
  error: {
    marginBottom: spacing.md,
    textAlign: "center",
  },
});
