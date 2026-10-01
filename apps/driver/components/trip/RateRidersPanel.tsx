import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Text, colors, getRateableRiders, rateRider, spacing } from "@rida/mobile-shared";
import type { RateableRider } from "@rida/mobile-shared";

/**
 * Phase 4: the driver rates their rider(s) after completion — the other half
 * of a rating system that previously only ran rider -> driver.
 *
 * Shown on the completion screen rather than as a blocking step: a driver's
 * next fare matters more than a rating prompt, so this is skippable by simply
 * tapping "Back to Home".
 */
export function RateRidersPanel({ rideId }: { rideId: string }) {
  const [riders, setRiders] = useState<RateableRider[]>([]);
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRateableRiders(rideId)
      .then((result) => {
        if (!cancelled) setRiders(result);
      })
      // A failed rating prompt must never disrupt the completion screen —
      // the driver has already been paid and needs to move on.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rideId]);

  async function handleRate(riderId: string, stars: number) {
    setSubmitting(riderId);
    // Optimistic: the star row is the only feedback, so it should respond
    // immediately rather than after a round trip.
    setRiders((current) =>
      current.map((r) => (r.riderId === riderId ? { ...r, stars } : r)),
    );
    try {
      await rateRider({ rideId, riderId, stars });
    } catch {
      Alert.alert("Couldn't save rating", "Please try again.");
      setRiders((current) =>
        current.map((r) => (r.riderId === riderId ? { ...r, stars: null } : r)),
      );
    } finally {
      setSubmitting(null);
    }
  }

  if (riders.length === 0) return null;

  return (
    <Card style={styles.rateCard}>
      <Text variant="label" color="muted">
        {riders.length === 1 ? "RATE YOUR RIDER" : "RATE YOUR RIDERS"}
      </Text>
      {riders.map((rider) => (
        <View key={rider.riderId} style={styles.rateRow}>
          <Text variant="bodyMedium" style={styles.rateName}>
            {rider.name}
          </Text>
          <View style={styles.starRow}>
            {[1, 2, 3, 4, 5].map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`${value} star${value === 1 ? "" : "s"} for ${rider.name}`}
                disabled={submitting === rider.riderId}
                onPress={() => void handleRate(rider.riderId, value)}
                hitSlop={4}
              >
                <Ionicons
                  name={rider.stars != null && value <= rider.stars ? "star" : "star-outline"}
                  size={26}
                  color={colors.accent[500]}
                />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  rateCard: { width: "100%", gap: spacing.md, marginBottom: spacing.lg },
  rateRow: { gap: spacing.xs },
  rateName: { marginBottom: spacing.xs },
  starRow: { flexDirection: "row", gap: spacing.sm },
});
