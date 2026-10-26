import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PRIVACY_URL, TERMS_URL } from "@rida/shared";
import { Button, Text, colors, spacing } from "../../design";
import { openLegalPage } from "./TermsConfirmation";
import { WelcomeHero } from "./WelcomeHero";

export interface WelcomeScreenProps {
  /** Under the animation's logo: the driver app's amber "DRIVER" chip. */
  badge?: string;
  title: string;
  body: string;
}

/**
 * The front door, both apps: the green hero with the CampusRide animation (a
 * car arriving at the Balme Library, played once), one line of what it is,
 * and ONE button. Everyone continues with their phone number; the code tells
 * new and returning people apart.
 */
export function WelcomeScreen({ badge, title, body }: WelcomeScreenProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <WelcomeHero badge={badge} />

      <View style={[styles.content, { paddingBottom: Math.max(insets.bottom, spacing[5]) }]}>
        <Text variant="title1" accessibilityRole="header">
          {title}
        </Text>
        <Text variant="body" color="secondary" style={styles.body}>
          {body}
        </Text>
        <View style={styles.button}>
          <Button
            label="Continue with phone number"
            icon="call-outline"
            onPress={() => router.push("/auth/phone")}
          />
        </View>
        <Text variant="caption" color="tertiary" style={styles.terms}>
          By continuing you agree to our{" "}
          <Text
            variant="caption"
            color="brand"
            style={styles.link}
            accessibilityRole="link"
            onPress={() => void openLegalPage(TERMS_URL)}
          >
            Terms
          </Text>{" "}
          and{" "}
          <Text
            variant="caption"
            color="brand"
            style={styles.link}
            accessibilityRole="link"
            onPress={() => void openLegalPage(PRIVACY_URL)}
          >
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  content: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[6],
  },
  body: {
    marginTop: spacing[2],
  },
  button: {
    marginTop: spacing[8],
  },
  terms: {
    marginTop: spacing[4],
    textAlign: "center",
  },
  link: {
    fontWeight: "700",
  },
});
