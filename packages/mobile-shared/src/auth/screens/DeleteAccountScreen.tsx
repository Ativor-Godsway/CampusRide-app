import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  ACCOUNT_DELETION_RETENTION_DAYS,
  OTP_RESEND_COOLDOWN_SECONDS,
  formatCountdown,
  retryAfterSecondsOf,
} from "@rida/shared";
import { useAuth } from "../AuthContext";
import { requestDeletionCode } from "../api";
import { describeDeleteAccountError, isRideBlockingDeletion } from "../deleteAccountFlow";
import { Button, Card, Input, Screen, Text, colors, spacing, typography } from "../../design";

type Step = "explain" | "code" | "blocked";

/**
 * Settings → Delete account, shared by the rider and driver apps (app-store
 * requirement). Says plainly what goes now, what is kept and for how long,
 * then confirms with a code texted to the account's phone. Refused, with a
 * friendly explanation, while a ride is going on. What the server does:
 * apps/server/src/services/auth/deleteAccount.ts.
 */
export function DeleteAccountScreen({ app }: { app: "rider" | "driver" }) {
  const router = useRouter();
  const { deleteAccount } = useAuth();
  const [step, setStep] = useState<Step>("explain");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blockedMessage, setBlockedMessage] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const secondsLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    if (secondsLeft === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  async function sendCode() {
    setError(null);
    setBusy(true);
    try {
      const { phone } = await requestDeletionCode();
      setMaskedPhone(phone);
      setResendAt(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
      setStep("code");
    } catch (err) {
      if (isRideBlockingDeletion(err)) {
        setBlockedMessage(describeDeleteAccountError(err));
        setStep("blocked");
      } else {
        const wait = retryAfterSecondsOf(err);
        if (wait !== null) setResendAt(Date.now() + wait * 1000);
        setError(describeDeleteAccountError(err));
      }
    } finally {
      setNow(Date.now());
      setBusy(false);
    }
  }

  async function confirm() {
    if (code.length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await deleteAccount(code);
      router.replace("/");
      Alert.alert(
        "Account deleted",
        "Your CampusRide account is closed. Thank you for riding with us.",
      );
    } catch (err) {
      if (isRideBlockingDeletion(err)) {
        setBlockedMessage(describeDeleteAccountError(err));
        setStep("blocked");
      } else {
        setError(describeDeleteAccountError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const goneNow = [
    "You're signed out on every phone and can't sign in to this account again.",
    "Your name and phone number disappear from CampusRide: other riders, drivers and CampusRide staff no longer see them.",
    app === "driver"
      ? "Your car's plate and your photo are removed, and you stop getting ride requests."
      : "Your emergency contact and SOS tracking links are removed.",
    "Notifications to your phone stop.",
  ];
  const keptForAWhile = [
    `Your name and phone number${app === "driver" ? ", car plate and photo" : ""} are kept privately for ${ACCOUNT_DELETION_RETENTION_DAYS} days, only in case of a safety report or a police request about a trip. Nobody sees them in the app.`,
    `After ${ACCOUNT_DELETION_RETENTION_DAYS} days they're erased, together with your notes, your exact pickup and drop-off points and your rating comments.`,
  ];
  const keptWithoutName = [
    app === "driver"
      ? "Your trip and cash commission records (date, area, fare) stay in CampusRide's accounts, without your name."
      : "Your trip records (date, area, fare) stay in CampusRide's accounts, without your name.",
  ];

  return (
    <Screen scroll style={styles.content}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.back}
      >
        <Ionicons name="chevron-back" size={22} color={colors.ink} />
        <Text variant="body">Back</Text>
      </Pressable>
      <Text variant="h2">Delete account</Text>

      {step === "blocked" ? (
        <Card style={styles.card}>
          <View style={styles.row}>
            <Ionicons name="car-outline" size={20} color={colors.primary[500]} />
            <Text variant="body" style={styles.flex}>
              {blockedMessage}
            </Text>
          </View>
          <Button label="Back" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : (
        <>
          <Section icon="trash-outline" title="Deleted straight away" items={goneNow} />
          <Section
            icon="time-outline"
            title={`Kept for ${ACCOUNT_DELETION_RETENTION_DAYS} days, then erased`}
            items={keptForAWhile}
          />
          <Section
            icon="document-text-outline"
            title="Kept without your name"
            items={keptWithoutName}
          />
          <Text variant="caption" color="muted">
            You can make a new account with the same number at any time; it starts empty.
          </Text>

          {step === "explain" ? (
            <View style={styles.actions}>
              {error ? (
                <Text variant="bodySmall" color="error">
                  {error}
                </Text>
              ) : null}
              <Button
                label={
                  secondsLeft > 0
                    ? `Send me a code in ${formatCountdown(secondsLeft)}`
                    : "Send me a code to confirm"
                }
                variant="danger"
                disabled={secondsLeft > 0}
                loading={busy}
                onPress={() => void sendCode()}
              />
              <Button label="Keep my account" variant="ghost" onPress={() => router.back()} />
            </View>
          ) : (
            <View style={styles.actions}>
              <Text variant="body">
                We sent a 6-digit code to {maskedPhone}. Enter it to delete your account. This can't
                be undone.
              </Text>
              <Input
                label="Code"
                placeholder="000000"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="sms-otp"
                maxLength={6}
                doneAccessory
                value={code}
                onChangeText={setCode}
                error={error ?? undefined}
                style={styles.codeInput}
              />
              <Button
                label="Delete my account"
                variant="danger"
                loading={busy}
                onPress={() => void confirm()}
              />
              <Button
                label={
                  secondsLeft > 0
                    ? `Send a new code in ${formatCountdown(secondsLeft)}`
                    : "Send a new code"
                }
                variant="ghost"
                disabled={secondsLeft > 0 || busy}
                onPress={() => void sendCode()}
              />
              <Button label="Keep my account" variant="ghost" onPress={() => router.back()} />
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

function Section({
  icon,
  title,
  items,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  items: string[];
}) {
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Ionicons name={icon} size={18} color={colors.ink2} />
        <Text variant="label">{title}</Text>
      </View>
      {items.map((item) => (
        <View key={item} style={styles.row}>
          <Text variant="bodySmall" color="muted">
            •
          </Text>
          <Text variant="bodySmall" style={styles.flex}>
            {item}
          </Text>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.md, paddingBottom: spacing["3xl"] },
  back: { flexDirection: "row", alignItems: "center", gap: spacing.xs, alignSelf: "flex-start" },
  card: { gap: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  flex: { flex: 1 },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  codeInput: {
    fontFamily: typography.fontFamily.mono,
    fontSize: 24,
    fontWeight: typography.weight.bold,
    textAlign: "center",
    letterSpacing: 8,
  },
});
