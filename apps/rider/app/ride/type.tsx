import { useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import type { RideType } from "@rida/shared";
import { getSharedFarePerRider, priceLoneRide } from "@rida/shared";
import {
  ActiveRideExistsError,
  Badge,
  Button,
  Card,
  LoadingState,
  Screen,
  Text,
  colors,
  createRide,
  formatGhs,
  spacing,
} from "@rida/mobile-shared";

export default function RideTypeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    pickupZoneId: string;
    dropoffZoneId: string;
    pickupZoneName: string;
    dropoffZoneName: string;
  }>();

  const [selectedType, setSelectedType] = useState<RideType>("SHARED");
  const [submitting, setSubmitting] = useState(false);

  const sharedRange = useMemo(() => {
    const fares = [1, 2, 3, 4].map((occ) => getSharedFarePerRider(occ));
    return { min: Math.min(...fares), max: Math.max(...fares) };
  }, []);

  const loneFare = useMemo(() => priceLoneRide().fare, []);

  async function handleSubmit() {
    if (!params.pickupZoneId || !params.dropoffZoneId) return;

    setSubmitting(true);
    try {
      const ride = await createRide({
        pickupZoneId: params.pickupZoneId,
        dropoffZoneId: params.dropoffZoneId,
        type: selectedType,
      });

      router.push({
        pathname: "/ride/searching",
        params: {
          rideId: ride.id,
          type: selectedType,
          pickupZoneName: params.pickupZoneName,
          dropoffZoneName: params.dropoffZoneName,
          priceLabel:
            selectedType === "SHARED"
              ? `${formatGhs(sharedRange.min)} - ${formatGhs(sharedRange.max)}`
              : formatGhs(loneFare),
        },
      });
    } catch (err) {
      if (err instanceof ActiveRideExistsError) {
        Alert.alert("Ride in progress", "You already have an active ride request.");
      } else {
        Alert.alert("Couldn't request a ride", "Please check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen scroll>
      <Text variant="h1">Choose your ride</Text>

      <View style={styles.route}>
        <Text variant="bodySmall" color="muted">
          {params.pickupZoneName} → {params.dropoffZoneName}
        </Text>
      </View>

      <Pressable accessibilityRole="button" onPress={() => setSelectedType("SHARED")}>
        <Card style={[styles.option, selectedType === "SHARED" && styles.optionSelected]}>
          <View style={styles.optionHeader}>
            <Text variant="h3">Shared</Text>
            <Badge label="Recommended" variant="success" />
          </View>
          <Text variant="h2" color="primary" style={styles.price}>
            {formatGhs(sharedRange.min)}–{formatGhs(sharedRange.max)}
          </Text>
          <Text variant="bodySmall" color="muted">
            Share & save — the more riders join, the cheaper it gets for everyone. Final price
            depends on how full the car is when it departs.
          </Text>
        </Card>
      </Pressable>

      <Pressable accessibilityRole="button" onPress={() => setSelectedType("LONE")}>
        <Card style={[styles.option, selectedType === "LONE" && styles.optionSelected]}>
          <View style={styles.optionHeader}>
            <Text variant="h3">Ride alone</Text>
          </View>
          <Text variant="h2" style={styles.price}>
            {formatGhs(loneFare)}
          </Text>
          <Text variant="bodySmall" color="muted">
            Skip the wait for other riders — a car is dispatched just for you, leaving as soon as
            it's matched.
          </Text>
        </Card>
      </Pressable>

      <View style={styles.footer}>
        {submitting ? (
          <LoadingState message="Requesting your ride..." />
        ) : (
          <Button
            label={selectedType === "SHARED" ? "Request shared ride" : "Request solo ride"}
            onPress={() => void handleSubmit()}
          />
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  route: { marginTop: spacing.xs, marginBottom: spacing.xl },
  option: { marginBottom: spacing.lg, gap: spacing.sm, borderWidth: 2 },
  optionSelected: { borderColor: colors.primary[500] },
  optionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  price: { marginTop: spacing.xs },
  footer: { marginTop: spacing.lg, marginBottom: spacing.xl, minHeight: 80 },
});
