import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { minutesAndDistance, offerKindLabel, splitFare, spokenCedis } from "@rida/shared";
import { Text, colors, formatCedis, radii, shadows, spacing, typography, useReduceMotion } from "@rida/mobile-shared";
import type { ShownOffer } from "../../lib/offers";
import { tapFeedback } from "../../lib/offerAlert";
import { CountdownRing } from "./CountdownRing";

/**
 * The ride offer pop-up on Home (Bolt/Uber style): fare and the two place
 * names first, then how far and how long, the rider, and ONE big Accept.
 * Slides up with a spring (a fade with Reduce Motion on). Names and numbers
 * only — the server sends no coordinates and no note before Accept.
 */
export function OfferCard({
  offer,
  waiting,
  onAccept,
  onDecline,
}: {
  offer: ShownOffer;
  waiting: number;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const enter = useRef(new Animated.Value(0)).current;
  const { item } = offer;

  useEffect(() => {
    enter.setValue(0);
    const anim = reduceMotion
      ? Animated.timing(enter, { toValue: 1, duration: 150, useNativeDriver: true })
      : Animated.spring(enter, { toValue: 1, damping: 18, stiffness: 190, mass: 0.9, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [item.rideId, reduceMotion, enter]);

  const seats = item.seats ?? 1;
  const from = item.pickupPlaceName ?? item.pickupZoneName;
  const to = item.dropoffPlaceName ?? item.dropoffZoneName;
  const pickup = minutesAndDistance(item.pickupMinutes ?? null, item.pickupDistanceMeters ?? null);
  const trip = minutesAndDistance(item.tripMinutes ?? null, item.tripDistanceMeters ?? null);
  const earn = item.driverSharePesewas ?? splitFare(item.farePesewas).driverShare;

  const style = reduceMotion
    ? { opacity: enter }
    : {
        opacity: enter.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
        transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) }],
      };

  return (
    <Animated.View
      style={[styles.card, { paddingBottom: Math.max(insets.bottom, spacing.lg) }, style]}
      accessibilityViewIsModal={false}
      accessibilityLiveRegion="assertive"
      accessibilityLabel={`New ride offer. ${offerKindLabel(item.type, seats)}, ${spokenCedis(item.farePesewas)}. From ${from} to ${to}.`}
    >
      <View style={styles.top}>
        <CountdownRing deadline={offer.deadline} totalMs={offer.deadline - offer.shownAt} size={60} />
        <View style={styles.kind}>
          <View style={[styles.kindPill, item.type === "SHARED" && styles.kindPillShared]}>
            <Ionicons name={item.type === "SHARED" ? "people" : "person"} size={13} color={colors.primary[600]} />
            <Text variant="caption" style={styles.kindText}>
              {offerKindLabel(item.type, seats)}
            </Text>
          </View>
          {waiting > 0 ? (
            <Text variant="caption" color="muted">
              +{waiting} more waiting
            </Text>
          ) : null}
        </View>
        <View style={styles.fareBlock}>
          <Text style={styles.fare}>{formatCedis(item.farePesewas)}</Text>
          <Text variant="caption" color="muted">
            You earn {formatCedis(earn)}
          </Text>
        </View>
      </View>

      <View style={styles.route}>
        <View style={styles.markers}>
          <View style={styles.pickupDot} />
          <View style={styles.connector} />
          <View style={styles.dropoffSquare} />
        </View>
        <View style={styles.places}>
          <Text style={styles.place} numberOfLines={2}>
            {from}
          </Text>
          <Text style={styles.place} numberOfLines={2}>
            {to}
          </Text>
        </View>
      </View>

      <View style={styles.metrics}>
        {pickup ? <Metric icon="navigate-outline" label="To pickup" value={pickup} /> : null}
        {trip ? <Metric icon="flag-outline" label="Trip" value={trip} /> : null}
      </View>

      {item.riderFirstName ? (
        <View style={styles.rider}>
          <Ionicons name="person-circle-outline" size={18} color={colors.ink2} />
          <Text variant="bodySmall" style={styles.riderName}>
            {item.riderFirstName}
          </Text>
          {item.riderRating != null ? (
            <>
              <Ionicons name="star" size={13} color={colors.accent[500]} />
              <Text variant="bodySmall" color="muted">
                {item.riderRating.toFixed(1)}
              </Text>
            </>
          ) : (
            <Text variant="caption" color="muted">
              New rider
            </Text>
          )}
        </View>
      ) : null}

      <Pressable
        onPress={() => {
          tapFeedback();
          onAccept();
        }}
        style={({ pressed }) => [styles.accept, pressed && styles.acceptPressed]}
        accessibilityRole="button"
        accessibilityLabel={`Accept, ${spokenCedis(item.farePesewas)}`}
      >
        <Text style={styles.acceptText}>Accept</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          tapFeedback();
          onDecline();
        }}
        style={styles.decline}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Decline this offer"
      >
        <Text variant="bodyMedium" color="muted" style={styles.declineText}>
          Decline
        </Text>
      </Pressable>
    </Animated.View>
  );
}

function Metric({ icon, label, value }: { icon: "navigate-outline" | "flag-outline"; label: string; value: string }) {
  return (
    <View style={styles.metric} accessible accessibilityLabel={`${label}: ${value}`}>
      <Ionicons name={icon} size={15} color={colors.ink2} />
      <View>
        <Text variant="caption" color="muted">
          {label}
        </Text>
        <Text variant="bodyMedium" style={styles.metricValue}>
          {value}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    backgroundColor: colors.white,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    ...shadows.lg,
  },
  top: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  kind: { flex: 1, gap: 4 },
  kindPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.full,
    backgroundColor: colors.surfaceMuted,
  },
  kindPillShared: { backgroundColor: colors.primary[50] },
  kindText: { color: colors.primary[600], fontWeight: typography.weight.bold },
  fareBlock: { alignItems: "flex-end" },
  fare: { fontSize: 34, lineHeight: 38, fontWeight: typography.weight.extrabold, color: colors.ink, fontVariant: ["tabular-nums"] },
  route: { flexDirection: "row", gap: spacing.md },
  markers: { alignItems: "center", paddingTop: 8, width: 12 },
  pickupDot: { width: 11, height: 11, borderRadius: radii.full, backgroundColor: colors.primary[500] },
  connector: { width: 2, flex: 1, minHeight: 18, backgroundColor: colors.border, marginVertical: 3 },
  dropoffSquare: { width: 11, height: 11, borderRadius: 2, backgroundColor: colors.ink, marginBottom: 8 },
  places: { flex: 1, gap: spacing.md },
  place: { fontSize: 19, lineHeight: 24, fontWeight: typography.weight.bold, color: colors.ink },
  metrics: { flexDirection: "row", gap: spacing.sm },
  metric: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
  },
  metricValue: { fontWeight: typography.weight.semibold },
  rider: { flexDirection: "row", alignItems: "center", gap: 6 },
  riderName: { fontWeight: typography.weight.semibold },
  accept: {
    height: 60,
    borderRadius: radii.lg,
    backgroundColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
  acceptPressed: { backgroundColor: colors.primary[600] },
  acceptText: { color: colors.white, fontSize: 19, fontWeight: typography.weight.extrabold },
  decline: { alignSelf: "center", paddingVertical: spacing.xs, paddingHorizontal: spacing.lg },
  declineText: { fontWeight: typography.weight.semibold },
});
