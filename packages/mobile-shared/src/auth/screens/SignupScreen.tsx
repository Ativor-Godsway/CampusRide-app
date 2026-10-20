import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet } from "react-native";
import { useAuth } from "../AuthContext";
import { Button, Input, Text, spacing } from "../../design";
import { errorMessage } from "../errorMessage";
import { AuthPage } from "./AuthPage";
import { AgeAndTermsCheckbox } from "./TermsConfirmation";

export interface SignupScreenProps {
  /** The account this app makes: the rider app riders, the driver app drivers. */
  role: "RIDER" | "DRIVER";
  /** The line under the title. */
  subtitle?: string;
}

/**
 * "What's your name?": the one step a new number takes after its code
 * (POST /auth/verify-code said "newAccount"). Name, the 18+ and terms tick,
 * Continue. Signed in, the auth layout (AuthStackLayout) moves on: a rider
 * to Home, a driver to onboarding.
 */
export function SignupScreen({
  role,
  subtitle = "So your driver knows who to look for.",
}: SignupScreenProps) {
  const router = useRouter();
  const { completeSignup } = useAuth();
  const { phone, verifiedToken } = useLocalSearchParams<{ phone: string; verifiedToken: string }>();
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Continue stays off until both are done, and says which is missing.
  const reason = !name.trim()
    ? "Enter your name to continue."
    : !confirmed
      ? "Tick the box to continue."
      : null;

  async function handleSubmit() {
    if (reason) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await completeSignup({ phone, name: name.trim(), role, verifiedToken });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthPage
      title="What's your name?"
      body={subtitle}
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/auth/welcome"))}
      footer={
        <>
          <Button
            label="Continue"
            disabled={reason !== null}
            loading={isSubmitting}
            onPress={() => void handleSubmit()}
          />
          {reason ? (
            <Text variant="subhead" color="tertiary" style={styles.reason}>
              {reason}
            </Text>
          ) : null}
        </>
      }
    >
      <Input
        label="Your name"
        placeholder="First and last name"
        autoComplete="name"
        textContentType="name"
        autoCapitalize="words"
        autoFocus
        returnKeyType="done"
        value={name}
        onChangeText={setName}
        error={error ?? undefined}
      />
      <AgeAndTermsCheckbox checked={confirmed} onChange={setConfirmed} />
    </AuthPage>
  );
}

const styles = StyleSheet.create({
  reason: {
    textAlign: "center",
    marginTop: spacing[1],
  },
});
