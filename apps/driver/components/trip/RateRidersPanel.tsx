import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { firstName, initialsOf } from "@rida/shared";
import {
  Text,
  colors,
  getRateableRiders,
  haptics,
  rateRider,
  spacing,
  type RateableRider,
} from "@rida/mobile-shared";

/**
 * Phase 4: the driver rates their rider(s) after completion — the other half
 * of a rating system that previously only ran rider -> driver. One row per
 * rider (a shared trip shows each): their initial, "Rate Kwame", five amber
 * stars; a tap saves at once.
 *
 * Shown on the completion screen rather than as a blocking step: a driver's
 * next fare matters more than a rating prompt, so this is skippable by simply
 * tapping "Find next trip".
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
    haptics.selection();
    setSubmitting(riderId);
    // Optimistic: the star row is the only feedback, so it should respond
    // immediately rather than after a round trip.
    setRiders((current) => current.map((r) => (r.riderId === riderId ? { ...r, stars } : r)));
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
    <View style={styles.list}>
      {riders.map((rider) => {
        const name = firstName(rider.name) || "your rider";
        return (
          <View key={rider.riderId} style={styles.row}>
            <View style={styles.avatar}>
              <Text variant="title3" color="brand">
                {initialsOf(name, 1) || "?"}
              </Text>
            </View>
            <Text variant="bodyStrong" style={styles.name} numberOfLines={1}>
              Rate {name}
            </Text>
            <View
              style={styles.stars}
              accessibilityRole="radiogroup"
              accessibilityLabel={`Rate ${name}`}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: rider.stars === value }}
                  accessibilityLabel={`${value} star${value === 1 ? "" : "s"} for ${name}`}
                  disabled={submitting === rider.riderId}
                  onPress={() => void handleRate(rider.riderId, value)}
                  hitSlop={4}
                >
                  <Ionicons
                    name="star"
                    size={30}
                    color={
                      rider.stars != null && value <= rider.stars
                        ? colors.amber400
                        : colors.surface3
                    }
                  />
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.green50,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { flex: 1 },
  stars: { flexDirection: "row", gap: spacing[1] },
});
