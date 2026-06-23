import { useCallback, useEffect, useRef, useState } from "react";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { Alert, Dimensions, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { DRIVER_CLIENT_EVENTS, getLoneFare, getSharedFarePerRider, splitFare } from "@rida/shared";
import type { PaymentMethod, RideStatus } from "@rida/shared";
import {
  Button,
  CampusMapView,
  Card,
  LoadingState,
  Screen,
  Text,
  colors,
  formatGhs,
  getRideSocket,
  getDriverActiveRide,
  driverMarkArrived,
  driverDepart,
  driverComplete,
  radii,
  RouteStops,
  shadows,
  spacing,
  typography,
  useAuth,
} from "@rida/mobile-shared";
import type { RideWithZones } from "@rida/mobile-shared";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const MAP_HEIGHT = SCREEN_HEIGHT * 0.55;
const LOCATION_INTERVAL_MS = 4_000;

type ActionStep = "navigate" | "arrived" | "depart" | "complete" | "done";

function stepFromStatus(status: RideStatus): ActionStep {
  if (status === "MATCHED") return "arrived";
  if (status === "ARRIVED") return "depart";
  if (status === "IN_PROGRESS") return "complete";
  if (status === "COMPLETED") return "done";
  return "navigate";
}

function stepLabel(step: ActionStep): string {
  if (step === "arrived") return "Mark Arrived";
  if (step === "depart") return "Start Ride";
  if (step === "complete") return "Complete Ride";
  return "";
}

function statusLabel(step: ActionStep): string {
  if (step === "arrived") return "Navigate to pickup";
  if (step === "depart") return "You've arrived — wait for rider";
  if (step === "complete") return "Ride in progress";
  if (step === "done") return "Ride completed";
  return "";
}

export default function ActiveRideScreen() {
  const { id: rideId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { isAuthenticated, user } = useAuth();

  const [ride, setRide] = useState<RideWithZones | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [step, setStep] = useState<ActionStep>("navigate");
  const [driverCoords, setDriverCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [earnedPesewas, setEarnedPesewas] = useState<number | null>(null);
  const [completedPaymentMethod, setCompletedPaymentMethod] = useState<PaymentMethod>("MOMO");
  const [commissionPesewas, setCommissionPesewas] = useState<number>(0);

  const locationWatchRef = useRef<Location.LocationSubscription | null>(null);
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load the active ride on mount.
  useEffect(() => {
    if (!isAuthenticated || !rideId) return;
    void getDriverActiveRide().then((r) => {
      if (r) {
        setRide(r);
        setStep(stepFromStatus(r.status));
      }
      setLoading(false);
    });
  }, [isAuthenticated, rideId]);

  // Start / stop GPS location streaming based on step.
  useEffect(() => {
    if (step !== "complete") {
      stopLocationStreaming();
      return;
    }
    if (!rideId) return;
    void startLocationStreaming(rideId);
    return () => stopLocationStreaming();
  }, [step, rideId]);

  const startLocationStreaming = useCallback(async (activeRideId: string) => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;

    const socket = getRideSocket();

    const sendLocation = async () => {
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const { latitude, longitude } = pos.coords;
        setDriverCoords({ latitude, longitude });
        socket.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, {
          rideId: activeRideId,
          lat: latitude,
          lng: longitude,
        });
      } catch {
        // location error — skip this tick
      }
    };

    await sendLocation();
    locationIntervalRef.current = setInterval(() => void sendLocation(), LOCATION_INTERVAL_MS);
  }, []);

  const stopLocationStreaming = useCallback(() => {
    if (locationWatchRef.current) {
      locationWatchRef.current.remove();
      locationWatchRef.current = null;
    }
    if (locationIntervalRef.current) {
      clearInterval(locationIntervalRef.current);
      locationIntervalRef.current = null;
    }
  }, []);

  const handleAction = useCallback(async () => {
    if (!rideId || acting) return;
    setActing(true);
    try {
      if (step === "arrived") {
        const updated = await driverMarkArrived(rideId);
        setStep(stepFromStatus(updated.status));
      } else if (step === "depart") {
        const updated = await driverDepart(rideId);
        setStep(stepFromStatus(updated.status));
      } else if (step === "complete") {
        const result = await driverComplete(rideId);
        setEarnedPesewas(result.driverSharePesewas);
        if (ride) {
          const method = ride.paymentMethod as PaymentMethod;
          setCompletedPaymentMethod(method);
          if (method === "CASH") {
            const totalFare =
              ride.type === "LONE"
                ? getLoneFare()
                : getSharedFarePerRider(ride.occupancy) * ride.occupancy;
            setCommissionPesewas(splitFare(totalFare).commission);
          }
        }
        setStep("done");
        stopLocationStreaming();
      }
    } catch {
      Alert.alert("Error", "Action failed. Please try again.");
    } finally {
      setActing(false);
    }
  }, [rideId, step, acting, stopLocationStreaming]);

  const handleDone = useCallback(() => {
    router.replace("/");
  }, [router]);

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/phone" />;
  }

  if (loading || !ride) {
    return (
      <Screen>
        <LoadingState message="Loading ride…" />
      </Screen>
    );
  }

  const pickup = { latitude: ride.pickupZone.latitude, longitude: ride.pickupZone.longitude };
  const dropoff = { latitude: ride.dropoffZone.latitude, longitude: ride.dropoffZone.longitude };

  const midLat = (pickup.latitude + dropoff.latitude) / 2;
  const midLng = (pickup.longitude + dropoff.longitude) / 2;
  const latDelta = Math.max(Math.abs(pickup.latitude - dropoff.latitude) * 1.8, 0.01);
  const lngDelta = Math.max(Math.abs(pickup.longitude - dropoff.longitude) * 1.8, 0.01);

  const mapZones = [
    { id: "pickup", label: ride.pickupZone.name, latitude: pickup.latitude, longitude: pickup.longitude, role: "pickup" as const },
    { id: "dropoff", label: ride.dropoffZone.name, latitude: dropoff.latitude, longitude: dropoff.longitude, role: "dropoff" as const },
  ];

  if (step === "done") {
    return (
      <Screen>
        <View style={styles.doneContainer}>
          <View style={styles.doneIconWrap}>
            <Ionicons name="checkmark-circle" size={72} color={colors.glowGreen} />
          </View>
          <Text variant="h1" style={styles.doneTitle}>
            Ride Complete
          </Text>

          {earnedPesewas !== null && completedPaymentMethod === "MOMO" && (
            <Card dark style={styles.earnCard}>
              <Text variant="label" color="glow">YOUR EARNINGS (85%)</Text>
              <Text variant="h1" color="inverse" style={styles.earnAmount}>
                {formatGhs(earnedPesewas)}
              </Text>
              <Text variant="caption" style={styles.earnCardSubtext}>
                MoMo payout follows once the rider's payment clears.
              </Text>
            </Card>
          )}

          {earnedPesewas !== null && completedPaymentMethod === "CASH" && (
            <Card dark style={styles.earnCard}>
              <Text variant="label" color="glow">COLLECT FROM RIDER</Text>
              <Text variant="h1" color="inverse" style={styles.earnAmount}>
                {formatGhs(earnedPesewas + commissionPesewas)}
              </Text>
              <View style={styles.cashBreakdown}>
                <Text variant="bodySmall" style={styles.earnCardSubtext}>
                  Your share: {formatGhs(earnedPesewas)}
                </Text>
                <Text variant="bodySmall" style={styles.earnCardSubtext}>
                  Platform fee owed: {formatGhs(commissionPesewas)}
                </Text>
              </View>
            </Card>
          )}

          <Text variant="bodySmall" color="muted" style={styles.doneBody}>
            {ride.pickupZone.name} → {ride.dropoffZone.name}
          </Text>
          <Button label="Back to Home" onPress={handleDone} size="lg" />
        </View>
      </Screen>
    );
  }

  return (
    <Screen noPadding noKeyboardHandling edges={["top"]}>
      {/* Full-bleed map */}
      <CampusMapView
        initialRegion={{ latitude: midLat, longitude: midLng, latitudeDelta: latDelta, longitudeDelta: lngDelta }}
        zones={mapZones}
        userLocation={driverCoords}
        height={MAP_HEIGHT}
        routeLine={[pickup, dropoff]}
        light
        showRecenter
        rounded={false}
      />

      {/* Bottom sheet */}
      <View style={styles.sheet}>
        {/* Status pill */}
        <View style={styles.statusPill}>
          <View style={styles.statusDot} />
          <Text variant="bodySmall" color="inverse">
            {statusLabel(step)}
          </Text>
        </View>

        {/* Route summary */}
        <RouteStops
          connectorHeight={32}
          origin={
            <View style={styles.zoneBlock}>
              <Text variant="label" color="muted">PICKUP</Text>
              <Text variant="bodyMedium">{ride.pickupZone.name}</Text>
              <Text variant="caption" color="muted">{ride.pickupZone.quadrant}</Text>
            </View>
          }
          destination={
            <View style={styles.zoneBlock}>
              <Text variant="label" color="muted">DROPOFF</Text>
              <Text variant="bodyMedium">{ride.dropoffZone.name}</Text>
              <Text variant="caption" color="muted">{ride.dropoffZone.quadrant}</Text>
            </View>
          }
        />

        {/* Primary action */}
        <Button
          label={stepLabel(step)}
          onPress={() => void handleAction()}
          loading={acting}
          size="lg"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
    marginTop: -radii["2xl"],
    ...shadows.lg,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceDark,
    alignSelf: "flex-start",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: radii.full,
    backgroundColor: colors.glowGreen,
  },
  routeRow: {
    flexDirection: "row",
    gap: spacing.md,
    flex: 1,
  },
  zoneBlock: {
    gap: 2,
  },
  // Done / completion screen
  doneContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
  doneIconWrap: {
    marginBottom: spacing.sm,
  },
  doneTitle: {
    textAlign: "center",
  },
  earnCard: {
    alignItems: "center",
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing["2xl"],
    gap: spacing.sm,
    width: "100%",
  },
  earnAmount: {
    fontWeight: typography.weight.extrabold,
  },
  earnCardSubtext: {
    color: "rgba(255,255,255,0.65)",
  },
  cashBreakdown: {
    marginTop: spacing.xs,
    gap: 2,
    alignItems: "center",
  },
  doneBody: {
    textAlign: "center",
  },
});
