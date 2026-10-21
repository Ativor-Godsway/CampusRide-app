import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  clockTime,
  priceLoneRide,
  type RideCompletedFareSummary,
  type RideType,
} from "@rida/shared";
import {
  BottomSheet,
  Button,
  Card,
  Skeleton,
  StatusChip,
  Text,
  colors,
  formatCedis,
  radii,
  rateLimitText,
  spacing,
  submitRating,
  useCountUp,
  type RideDriverInfo,
} from "@rida/mobile-shared";
import { haptics } from "../../lib/haptics";
import { DriverAvatar, firstNameOf } from "./DriverTripContent";

const STARS = [1, 2, 3, 4, 5] as const;
/** The fare counts up this fast (docs/design-system.md, "Motion"). */
const FARE_COUNT_MS = 600;

/** The round badge beside the heading: a green check, or a red cross. */
function StateBadge({ tone }: { tone: "done" | "cancelled" }) {
  const done = tone === "done";
  return (
    <View style={[styles.badge, { backgroundColor: done ? colors.green500 : colors.red50 }]}>
      <Ionicons
        name={done ? "checkmark" : "close"}
        size={24}
        color={done ? colors.onBrand : colors.red600}
      />
    </View>
  );
}

/**
 * The fare as the hero: counts up in whole cedis, then shows the exact fare
 * (so a fare with pesewas never flickers through decimals).
 */
function Fare({ pesewas }: { pesewas: number }) {
  const target = Math.floor(pesewas / 100);
  const cedis = useCountUp(target, FARE_COUNT_MS);
  return (
    <Text variant="display" tabular accessibilityLabel={formatCedis(pesewas)}>
      {formatCedis(cedis >= target ? pesewas : cedis * 100)}
    </Text>
  );
}

/**
 * Trip complete (docs/mockups/07-rider-trip-complete.png): one modal sheet
 * over the dimmed map — where they are and when, the fare to pay in cash,
 * and the rating. "Done" sends the rating if one was picked, else just
 * closes. Cash-only launch: there is no "Pay with MoMo" here.
 *
 * No tag chips ("Safe driving", "Late", …): POST /ratings takes only stars
 * and a free-text comment.
 */
export function TripCompleteSheet({
  rideId,
  rideType,
  fareSummary,
  driver,
  dropoffName,
  completedAt,
  onDone,
}: {
  rideId: string;
  rideType: RideType;
  /** From GET /rides/:id once COMPLETED; undefined for a moment before. */
  fareSummary: RideCompletedFareSummary | undefined;
  driver: RideDriverInfo | null | undefined;
  dropoffName: string;
  completedAt: Date | string | null | undefined;
  onDone: () => void;
}) {
  const [stars, setStars] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // The trip is over: one success buzz as the sheet appears.
  useEffect(() => {
    haptics.success();
  }, []);

  const driverName = driver ? firstNameOf(driver.name) : null;
  const fare = fareSummary?.yourFarePesewas;
  const savings =
    fare !== undefined && rideType === "SHARED" ? Math.max(0, priceLoneRide().fare - fare) : 0;

  async function done() {
    if (stars === 0) {
      onDone();
      return;
    }
    setSubmitting(true);
    try {
      await submitRating({ rideId, stars });
      onDone();
    } catch (err) {
      Alert.alert("Couldn't send your rating", rateLimitText(err) ?? "Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      modal
      visible
      dismissible={false}
      accessibilityLabel="You've arrived"
      contentStyle={styles.content}
      footer={<Button label="Done" onPress={() => void done()} loading={submitting} />}
    >
      <View style={styles.heading}>
        <StateBadge tone="done" />
        <View style={styles.headingText}>
          <Text variant="title2" accessibilityRole="header">
            You&apos;ve arrived
          </Text>
          <Text variant="subhead" color="secondary">
            {completedAt ? `${dropoffName} · ${clockTime(completedAt)}` : dropoffName}
          </Text>
        </View>
      </View>

      <Card variant="filled" style={styles.fareCard}>
        {fare === undefined ? (
          <Skeleton width={120} height={44} />
        ) : (
          <View style={styles.fareRow}>
            <Fare pesewas={fare} />
            <View style={styles.cash}>
              <Ionicons name="cash-outline" size={20} color={colors.ink2} />
              <Text variant="body" color="secondary" style={styles.cashText}>
                {driverName ? `Pay ${driverName} in cash` : "Pay your driver in cash"}
              </Text>
            </View>
          </View>
        )}
        {savings > 0 ? (
          <StatusChip
            tone="brand"
            label={`You saved ${formatCedis(savings)} by sharing`}
            style={styles.savings}
          />
        ) : null}
      </Card>

      {driver ? (
        <>
          <View style={styles.divider} />
          <View style={styles.rating}>
            <DriverAvatar driver={driver} size={56} />
            <Text variant="title3" style={styles.centered}>
              How was your ride with {driverName}?
            </Text>
            <View
              style={styles.stars}
              accessibilityRole="radiogroup"
              accessibilityLabel="Rate your ride"
            >
              {STARS.map((value) => (
                <Pressable
                  key={value}
                  onPress={() => {
                    haptics.selection();
                    setStars(value);
                  }}
                  disabled={submitting}
                  hitSlop={4}
                  accessibilityRole="radio"
                  accessibilityLabel={`${value} star${value === 1 ? "" : "s"}`}
                  accessibilityState={{ checked: stars === value }}
                >
                  <Ionicons
                    name="star"
                    size={44}
                    color={value <= stars ? colors.amber400 : colors.surface3}
                  />
                </Pressable>
              ))}
            </View>
          </View>
        </>
      ) : null}
    </BottomSheet>
  );
}

/** The trip ended without the rider: the same sheet, with a red cross. */
export function TripCancelledSheet({
  title = "Ride cancelled",
  message = "Your request has been cancelled.",
  onDone,
}: {
  title?: string;
  message?: string;
  onDone: () => void;
}) {
  return (
    <BottomSheet
      modal
      visible
      dismissible={false}
      accessibilityLabel={title}
      contentStyle={styles.content}
      footer={<Button label="Back to home" onPress={onDone} />}
    >
      <View style={styles.heading}>
        <StateBadge tone="cancelled" />
        <View style={styles.headingText}>
          <Text variant="title2" accessibilityRole="header">
            {title}
          </Text>
          <Text variant="subhead" color="secondary">
            {message}
          </Text>
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[5] },
  heading: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  headingText: { flex: 1, gap: 2 },
  badge: {
    width: 40,
    height: 40,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
  fareCard: { gap: spacing[3], padding: spacing[5] },
  fareRow: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  cash: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing[2],
  },
  cashText: { flexShrink: 1 },
  savings: { alignSelf: "flex-start" },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  rating: { alignItems: "center", gap: spacing[3] },
  centered: { textAlign: "center" },
  stars: { flexDirection: "row", gap: spacing[2] },
});
