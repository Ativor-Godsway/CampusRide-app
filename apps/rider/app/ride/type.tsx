import { useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import type { RideType } from "@rida/shared";
import { getSharedFarePerRider, priceLoneRide } from "@rida/shared";
import {
  ActiveRideExistsError,
  Badge,
  Button,
  Card,
  CampusMapView,
  LoadingState,
  ServiceIcon,
  Text,
  colors,
  createRide,
  formatGhs,
  radii,
  regionForCoordinates,
  spacing,
} from "@rida/mobile-shared";

interface RideOption {
  type: RideType;
  title: string;
  priceLabel: string;
  summary: string;
  details: string;
  icon: keyof typeof Ionicons.glyphMap;
}

export default function RideTypeScreen() {
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();

  const params = useLocalSearchParams<{
    pickupZoneId: string;
    dropoffZoneId: string;
    pickupZoneName: string;
    dropoffZoneName: string;
    pickupLat: string;
    pickupLng: string;
    dropoffLat: string;
    dropoffLng: string;
  }>();

  const [selectedType, setSelectedType] = useState<RideType>("SHARED");
  const [expandedType, setExpandedType] = useState<RideType | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sharedRange = useMemo(() => {
    const fares = [1, 2, 3, 4].map((occ) => getSharedFarePerRider(occ));
    return { min: Math.min(...fares), max: Math.max(...fares) };
  }, []);

  const loneFare = useMemo(() => priceLoneRide().fare, []);

  const options: RideOption[] = useMemo(
    () => [
      {
        type: "SHARED",
        title: "Shared",
        priceLabel: `${formatGhs(sharedRange.min)} – ${formatGhs(sharedRange.max)}`,
        summary: "Share with others & save",
        details:
          "Share & save — the more riders join, the cheaper it gets for everyone. Final price depends on how full the car is when it departs.",
        icon: "people",
      },
      {
        type: "LONE",
        title: "Ride alone",
        priceLabel: formatGhs(loneFare),
        summary: "Private ride, no waiting",
        details:
          "Skip the wait for other riders — a car is dispatched just for you, leaving as soon as it's matched.",
        icon: "car-sport",
      },
    ],
    [sharedRange, loneFare],
  );

  const pickupCoord = useMemo(
    () => ({ latitude: Number(params.pickupLat), longitude: Number(params.pickupLng) }),
    [params.pickupLat, params.pickupLng],
  );
  const dropoffCoord = useMemo(
    () => ({ latitude: Number(params.dropoffLat), longitude: Number(params.dropoffLng) }),
    [params.dropoffLat, params.dropoffLng],
  );

  const region = useMemo(
    () => regionForCoordinates([pickupCoord, dropoffCoord], 0.8),
    [pickupCoord, dropoffCoord],
  );

  const mapZones = useMemo(
    () => [
      { id: "pickup", ...pickupCoord, label: params.pickupZoneName, role: "pickup" as const },
      { id: "dropoff", ...dropoffCoord, label: params.dropoffZoneName, role: "dropoff" as const },
    ],
    [pickupCoord, dropoffCoord, params.pickupZoneName, params.dropoffZoneName],
  );

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
    <View style={styles.container}>
      <CampusMapView
        initialRegion={region}
        zones={mapZones}
        routeLine={[pickupCoord, dropoffCoord]}
        height={windowHeight}
        light
        showRecenter
        rounded={false}
      />

      <BottomSheet
        snapPoints={["40%", "85%"]}
        index={0}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.sheetHandle}
      >
        <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
          <Text variant="h1">Choose your ride</Text>

          <View style={styles.route}>
            <Text variant="bodySmall" color="muted">
              {params.pickupZoneName} → {params.dropoffZoneName}
            </Text>
          </View>

          {options.map((option) => {
            const isSelected = selectedType === option.type;
            const isExpanded = expandedType === option.type;
            return (
              <Pressable
                key={option.type}
                accessibilityRole="button"
                onPress={() => setSelectedType(option.type)}
              >
                <Card style={[styles.option, isSelected && styles.optionSelected]}>
                  <View style={styles.optionRow}>
                    <ServiceIcon
                      name={option.icon}
                      size={52}
                      iconSize={26}
                      background={isSelected ? colors.primary[50] : colors.surface}
                      color={isSelected ? colors.primary[600] : colors.ink[500]}
                    />
                    <View style={styles.optionInfo}>
                      <View style={styles.optionHeader}>
                        <Text variant="h3">{option.title}</Text>
                        {option.type === "SHARED" ? (
                          <Badge label="Recommended" variant="success" />
                        ) : null}
                      </View>
                      <Text variant="h2" color={isSelected ? "primary" : undefined} style={styles.price}>
                        {option.priceLabel}
                      </Text>
                      <Text variant="bodySmall" color="muted">
                        {option.summary}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={isExpanded ? "Hide details" : "Show details"}
                      onPress={() => setExpandedType(isExpanded ? null : option.type)}
                      style={styles.chevron}
                    >
                      <Ionicons
                        name={isExpanded ? "chevron-up" : "chevron-down"}
                        size={20}
                        color={colors.ink[400]}
                      />
                    </Pressable>
                  </View>
                  {isExpanded ? (
                    <Text variant="bodySmall" color="muted" style={styles.details}>
                      {option.details}
                    </Text>
                  ) : null}
                </Card>
              </Pressable>
            );
          })}

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
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sheetBackground: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
  },
  sheetHandle: {
    backgroundColor: colors.border,
    width: 40,
  },
  sheetContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
  },
  route: { marginTop: spacing.xs, marginBottom: spacing.lg },
  option: { marginBottom: spacing.lg, borderWidth: 2, borderColor: "transparent" },
  optionSelected: { borderColor: colors.primary[500] },
  optionRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  optionInfo: { flex: 1, gap: 2 },
  optionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  price: { marginTop: 2 },
  chevron: { padding: spacing.xs },
  details: { marginTop: spacing.md },
  footer: { marginTop: spacing.sm, marginBottom: spacing.xl, minHeight: 80 },
});
