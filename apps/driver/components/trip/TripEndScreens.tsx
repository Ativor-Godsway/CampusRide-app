import { useEffect, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Card,
  Text,
  colors,
  formatCedis,
  haptics,
  radii,
  spacing,
  useCountUp,
} from "@rida/mobile-shared";
import { RateRidersPanel } from "./RateRidersPanel";

/** The fare counts up this fast (docs/design-system.md, "Motion"). */
const FARE_COUNT_MS = 600;

/** A white page with the action pinned at the bottom, for the end of a trip. */
function EndPage({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, { paddingTop: insets.top + spacing[8] }]}>
      <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]}>
        {footer}
      </View>
    </View>
  );
}

/**
 * The badge at the top (mockup 12): a 60px circle in an 84px ring. Green with
 * a check and two small amber dots when the trip is done; grey otherwise.
 */
function StateBadge({ tone }: { tone: "done" | "ended" }) {
  const done = tone === "done";
  return (
    <View style={styles.badgeWrap} importantForAccessibility="no-hide-descendants">
      <View style={[styles.ring, { backgroundColor: done ? colors.green50 : colors.surface2 }]}>
        <View style={[styles.circle, { backgroundColor: done ? colors.green500 : colors.ink3 }]}>
          <Ionicons name={done ? "checkmark" : "flag"} size={30} color={colors.onBrand} />
        </View>
      </View>
      {done ? (
        <>
          <View style={[styles.dot, styles.dotBig]} />
          <View style={[styles.dot, styles.dotSmall]} />
        </>
      ) : null}
    </View>
  );
}

/** Counts up in whole cedis, then shows the exact amount (no flicker through decimals). */
function CountUpFare({ pesewas }: { pesewas: number }) {
  const target = Math.floor(pesewas / 100);
  const cedis = useCountUp(target, FARE_COUNT_MS);
  return (
    <Text variant="display" color="onDark" tabular accessibilityLabel={formatCedis(pesewas)}>
      {formatCedis(cedis >= target ? pesewas : cedis * 100)}
    </Text>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text variant="body" color="onDark2">
        {label}
      </Text>
      <Text variant="bodyStrong" color="onDark" tabular>
        {value}
      </Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="subhead" color="secondary">
        {label}
      </Text>
      <Text variant="title3" tabular>
        {value}
      </Text>
    </View>
  );
}

/**
 * Trip complete (docs/mockups/12-driver-trip-complete.png): the badge, the
 * route, the dark card with the cash collected and how it splits, today so
 * far, a star row per rider, and "Find next trip". A success buzz on arrival.
 */
export function TripCompleteView({
  rideId,
  route,
  cash,
  totalPesewas,
  driverSharePesewas,
  commissionPesewas,
  today,
  onFindNext,
}: {
  rideId: string;
  /** "Maison Française → Night Market". */
  route: string;
  cash: boolean;
  totalPesewas: number;
  driverSharePesewas: number;
  commissionPesewas: number;
  /** Today so far (completed trips, by the phone's clock), or null until it loads. */
  today: { pesewas: number; trips: number } | null;
  onFindNext: () => void;
}) {
  useEffect(() => {
    haptics.success();
  }, []);

  return (
    <EndPage footer={<Button label="Find next trip" onPress={onFindNext} />}>
      <StateBadge tone="done" />
      <View style={styles.heading}>
        <Text variant="title1" style={styles.centered} accessibilityRole="header">
          Trip complete
        </Text>
        <Text variant="subhead" color="secondary" style={styles.centered}>
          {route}
        </Text>
      </View>

      <Card variant="dark" style={styles.fareCard}>
        <Text variant="eyebrow" color="greenOnDark">
          {cash ? "Cash collected" : "Fare (paid by MoMo)"}
        </Text>
        <CountUpFare pesewas={totalPesewas} />
        <View style={styles.rows}>
          <Row label="Your share" value={formatCedis(driverSharePesewas)} />
          <Row label="Commission (15%)" value={formatCedis(commissionPesewas)} />
        </View>
      </Card>

      {today ? (
        <Card variant="filled" style={styles.stats}>
          <Stat label="Today" value={formatCedis(today.pesewas)} />
          <Stat label="Trips" value={String(today.trips)} />
        </Card>
      ) : null}

      <RateRidersPanel rideId={rideId} />
    </EndPage>
  );
}

/** The trip ended without the driver finishing it (the rider cancelled, or it was closed). */
export function TripEndedView({
  title,
  message,
  onHome,
}: {
  title: string;
  message: string;
  onHome: () => void;
}) {
  return (
    <EndPage footer={<Button label="Back to Home" onPress={onHome} />}>
      <StateBadge tone="ended" />
      <View style={styles.heading}>
        <Text variant="title1" style={styles.centered} accessibilityRole="header">
          {title}
        </Text>
        <Text variant="body" color="secondary" style={styles.centered}>
          {message}
        </Text>
      </View>
    </EndPage>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface },
  body: { paddingHorizontal: spacing.gutter, gap: spacing[5], paddingBottom: spacing[6] },
  footer: { paddingHorizontal: spacing.gutter, paddingTop: spacing[3] },
  heading: { gap: spacing[2] },
  centered: { textAlign: "center" },
  badgeWrap: {
    alignSelf: "center",
    width: 112,
    height: 96,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: { width: 84, height: 84, borderRadius: 42, alignItems: "center", justifyContent: "center" },
  circle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { position: "absolute", borderRadius: radii.full, backgroundColor: colors.amber400 },
  dotBig: { width: 12, height: 12, top: 2, right: 8 },
  dotSmall: { width: 8, height: 8, bottom: 22, left: 6 },
  fareCard: { gap: spacing[2] },
  rows: { gap: spacing[2], marginTop: spacing[2] },
  row: { flexDirection: "row", justifyContent: "space-between", gap: spacing[3] },
  stats: { flexDirection: "row", gap: spacing[6] },
  stat: { gap: 2 },
});
