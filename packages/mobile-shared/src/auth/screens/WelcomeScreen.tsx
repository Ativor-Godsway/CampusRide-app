import { Image, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import Svg, { Circle, Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PRIVACY_URL, TERMS_URL } from "@rida/shared";
import {
  Button,
  Illustration,
  StatusChip,
  Text,
  colors,
  illustrations,
  radii,
  spacing,
} from "../../design";
import { openLegalPage } from "./TermsConfirmation";

export interface WelcomeScreenProps {
  /** Beside the wordmark: the driver app's amber "DRIVER" chip. */
  badge?: string;
  title: string;
  body: string;
}

const HERO_HEIGHT = 452;

/**
 * The front door (docs/mockups/01-rider-welcome.png), both apps: the green
 * hero with soft road lines, the logo and wordmark, the car over the hero's
 * edge, one line of what it is, and ONE button. Everyone continues with
 * their phone number; the code tells new and returning people apart.
 */
export function WelcomeScreen({ badge, title, body }: WelcomeScreenProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <View style={[styles.hero, { paddingTop: insets.top + spacing[6] }]}>
        <RoadLines />
        <View style={styles.wordmarkRow}>
          <View style={styles.logoBadge}>
            <Image source={illustrations.logoMark} style={styles.logo} resizeMode="contain" />
          </View>
          <Text variant="title2" color="onBrand" style={styles.wordmark}>
            CampusRide
          </Text>
          {badge ? <StatusChip label={badge} tone="amber" style={styles.badge} /> : null}
        </View>
        <Text variant="body" color="onBrand" style={styles.place}>
          University of Ghana, Legon
        </Text>
        <Illustration name="carStandard" width={330} style={styles.car} />
      </View>

      <View style={[styles.content, { paddingBottom: Math.max(insets.bottom, spacing[5]) }]}>
        <Text variant="title1" accessibilityRole="header">
          {title}
        </Text>
        <Text variant="body" color="secondary" style={styles.body}>
          {body}
        </Text>
        <View style={styles.spacer} />
        <Button
          label="Continue with phone number"
          icon="call-outline"
          onPress={() => router.push("/auth/phone")}
        />
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

/** Soft roads across the hero, and the amber dot of the logo's car. Decorative. */
function RoadLines() {
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width="100%" height="100%" viewBox={`0 0 390 ${HERO_HEIGHT}`} preserveAspectRatio="none">
        <Path
          d="M-20 118 C 90 150 230 150 410 66"
          stroke={colors.onBrand}
          strokeOpacity={0.1}
          strokeWidth={26}
          fill="none"
        />
        <Path
          d="M-20 292 C 120 268 250 300 410 222"
          stroke={colors.onBrand}
          strokeOpacity={0.1}
          strokeWidth={26}
          fill="none"
        />
        <Path
          d="M122 -10 C 112 150 116 320 148 470"
          stroke={colors.onBrand}
          strokeOpacity={0.1}
          strokeWidth={22}
          fill="none"
        />
        <Circle cx={318} cy={96} r={9} fill={colors.amber400} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  hero: {
    height: HERO_HEIGHT,
    backgroundColor: colors.green500,
    paddingHorizontal: spacing.gutter,
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
  },
  logoBadge: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: 30,
    height: 30,
  },
  wordmark: {
    fontWeight: "800",
  },
  badge: {
    alignSelf: "center",
  },
  place: {
    marginTop: spacing[6],
    opacity: 0.9,
  },
  // Over the hero's bottom edge, as in the mockup.
  car: {
    position: "absolute",
    alignSelf: "center",
    bottom: -spacing[6],
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[10] + spacing[4],
  },
  body: {
    marginTop: spacing[2],
  },
  spacer: {
    flex: 1,
  },
  terms: {
    marginTop: spacing[4],
    textAlign: "center",
  },
  link: {
    fontWeight: "700",
  },
});
