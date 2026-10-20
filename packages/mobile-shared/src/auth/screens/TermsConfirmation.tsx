import { useState } from "react";
import { usePathname, useRouter } from "expo-router";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { PRIVACY_URL, TERMS_URL, needsTermsConfirmation } from "@rida/shared";
import { useAuth } from "../AuthContext";
import { errorMessage } from "../errorMessage";
import { Button, Text, colors, spacing } from "../../design";
import { AuthPage } from "./AuthPage";

/** Opens one of the website's pages in the in-app browser (the phone's browser if that fails). */
export async function openLegalPage(url: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    await Linking.openURL(url).catch(() => undefined);
  }
}

export interface AgeAndTermsCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * "I'm 18 or older and I agree to the Terms and Privacy Policy": the one
 * required tick at sign-up, and on the confirmation an older account sees
 * once. "Terms" and "Privacy Policy" open campusride.app in the in-app
 * browser; tapping anywhere else toggles the box.
 */
export function AgeAndTermsCheckbox({ checked, onChange }: AgeAndTermsCheckboxProps) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel="I'm 18 or older and I agree to the Terms and Privacy Policy"
      onPress={() => onChange(!checked)}
      style={styles.row}
      hitSlop={4}
    >
      <View style={[styles.box, checked && styles.boxChecked]}>
        {checked ? <Ionicons name="checkmark" size={18} color={colors.onBrand} /> : null}
      </View>
      <Text variant="body" style={styles.label}>
        I&apos;m 18 or older and I agree to the{" "}
        <Text variant="bodyStrong" color="brand" accessibilityRole="link" onPress={() => void openLegalPage(TERMS_URL)}>
          Terms
        </Text>{" "}
        and{" "}
        <Text variant="bodyStrong" color="brand" accessibilityRole="link" onPress={() => void openLegalPage(PRIVACY_URL)}>
          Privacy Policy
        </Text>
      </Text>
    </Pressable>
  );
}

/**
 * For an account from before sign-up asked: the same confirmation, once, over
 * every screen of the app until it's given. The only ways past it are to
 * confirm, log out, or delete the account (the Delete account screen shows
 * through it). Render once in the app's root layout, after the Stack.
 */
export function TermsConfirmationGate() {
  const { user, isAuthenticated } = useAuth();
  const pathname = usePathname();
  if (!isAuthenticated || !user || !needsTermsConfirmation(user)) return null;
  if (pathname === "/delete-account") return null;
  return (
    <View style={styles.overlay}>
      <TermsConfirmationScreen />
    </View>
  );
}

function TermsConfirmationScreen() {
  const router = useRouter();
  const { confirmTerms, signOut } = useAuth();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    setBusy(true);
    try {
      await confirmTerms();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPage
      title="Before you continue"
      body="CampusRide is for people aged 18 or over. Please confirm this, and that you agree to our Terms and Privacy Policy, to keep using the app."
      footer={
        <>
          <Button label="Continue" disabled={!checked} loading={busy} onPress={() => void handleContinue()} />
          {!checked ? (
            <Text variant="subhead" color="tertiary" style={styles.centered}>
              Tick the box to continue.
            </Text>
          ) : null}
          <Text variant="subhead" color="secondary" style={styles.otherwise}>
            Don&apos;t agree? You can log out, or delete your account.
          </Text>
          <Button label="Log out" variant="text" disabled={busy} onPress={() => void signOut()} />
          <Button
            label="Delete my account"
            variant="danger"
            disabled={busy}
            onPress={() => router.push("/delete-account")}
          />
        </>
      }
    >
      <AgeAndTermsCheckbox checked={checked} onChange={setChecked} />
      {error ? (
        <Text variant="subhead" color="danger">
          {error}
        </Text>
      ) : null}
    </AuthPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    // A border that carries meaning (an unticked box): line-strong, 3:1.
    borderColor: colors.lineStrong,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  boxChecked: {
    backgroundColor: colors.green500,
    borderColor: colors.green500,
  },
  label: {
    flex: 1,
  },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: colors.surface,
  },
  centered: {
    textAlign: "center",
  },
  otherwise: {
    marginTop: spacing[4],
    textAlign: "center",
  },
});
