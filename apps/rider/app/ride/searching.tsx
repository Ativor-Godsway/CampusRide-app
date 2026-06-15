import { useEffect, useMemo, useState } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import {
  Badge,
  Button,
  Card,
  CampusMapView,
  type CampusMapZone,
  LoadingState,
  ProgressBar,
  Screen,
  Text,
  cancelRide,
  colors,
  radii,
  regionForCoordinates,
  spacing,
  submitRating,
  submitRideDecision,
  useDriverLocation,
  useRideTracking,
  type RideDriverInfo,
} from "@rida/mobile-shared";

const DUMMY_ETA_MINUTES = 4;
const STARS = [1, 2, 3, 4, 5];
const BROADCAST_WINDOW_MS = 90_000;

export default function SearchingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    rideId: string;
    type: string;
    pickupZoneName: string;
    dropoffZoneName: string;
    priceLabel: string;
  }>();

  const { height: windowHeight } = useWindowDimensions();

  const { data, isLoading } = useRideTracking(params.rideId);
  const [driverLocation, setDriverLocation] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );
  const [decisionSubmitting, setDecisionSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useDriverLocation(params.rideId, (payload) => {
    setDriverLocation({ latitude: payload.lat, longitude: payload.lng });
  });

  const ride = data?.ride;
  const driver = data?.driver;

  useEffect(() => {
    if (ride?.status !== "REQUESTED") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [ride?.status]);

  const pickupCoord = useMemo(
    () => (ride ? { latitude: ride.pickupZone.latitude, longitude: ride.pickupZone.longitude } : null),
    [ride],
  );
  const dropoffCoord = useMemo(
    () => (ride ? { latitude: ride.dropoffZone.latitude, longitude: ride.dropoffZone.longitude } : null),
    [ride],
  );

  const region = useMemo(() => {
    if (!pickupCoord || !dropoffCoord) return null;
    const points = [pickupCoord, dropoffCoord];
    if (driverLocation) points.push(driverLocation);
    return regionForCoordinates(points, 0.8);
  }, [pickupCoord, dropoffCoord, driverLocation]);

  const mapZones = useMemo(() => {
    if (!pickupCoord || !dropoffCoord) return [];
    const zones: CampusMapZone[] = [
      { id: "pickup", ...pickupCoord, label: params.pickupZoneName, role: "pickup" },
      { id: "dropoff", ...dropoffCoord, label: params.dropoffZoneName, role: "dropoff" },
    ];
    if (driverLocation) {
      zones.push({ id: "driver", ...driverLocation, label: "Driver" });
    }
    return zones;
  }, [pickupCoord, dropoffCoord, driverLocation, params.pickupZoneName, params.dropoffZoneName]);

  const searchProgress = useMemo(() => {
    if (!ride?.broadcastStartedAt) return 1;
    const start = new Date(ride.broadcastStartedAt).getTime();
    const elapsed = now - start;
    return Math.max(0, Math.min(1, 1 - elapsed / BROADCAST_WINDOW_MS));
  }, [ride?.broadcastStartedAt, now]);

  async function handleDecision(action: "KEEP_WAITING" | "SWITCH_TO_LONE" | "CANCEL") {
    if (!params.rideId) return;
    setDecisionSubmitting(true);
    try {
      await submitRideDecision(params.rideId, action);
      if (action === "CANCEL") {
        router.replace("/");
      }
    } catch {
      Alert.alert("Something went wrong", "Please try again.");
    } finally {
      setDecisionSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!params.rideId) return;
    setCancelling(true);
    try {
      await cancelRide(params.rideId);
      router.replace("/");
    } catch {
      Alert.alert("Couldn't cancel", "Please try again.");
    } finally {
      setCancelling(false);
    }
  }

  if (isLoading || !ride || !region || !pickupCoord || !dropoffCoord) {
    return (
      <Screen>
        <LoadingState message="Loading your ride..." />
      </Screen>
    );
  }

  const canSwitchToLone = ride.type === "SHARED" && ride.occupancy === 1;

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
          {ride.status === "REQUESTED" && (
            <SearchingContent
              pickupZoneName={params.pickupZoneName}
              dropoffZoneName={params.dropoffZoneName}
              priceLabel={params.priceLabel}
              rideType={params.type}
              progress={searchProgress}
              canSwitchToLone={canSwitchToLone}
              onSwitchToLone={() => void handleDecision("SWITCH_TO_LONE")}
              switching={decisionSubmitting}
              onCancel={() => void handleCancel()}
              cancelling={cancelling}
            />
          )}

          {ride.status === "AWAITING_RIDER_DECISION" && (
            <NoDriverContent
              canSwitchToLone={canSwitchToLone}
              submitting={decisionSubmitting}
              onAction={(action) => void handleDecision(action)}
            />
          )}

          {(ride.status === "MATCHED" || ride.status === "ARRIVED") && driver && (
            <DriverFoundContent
              status={ride.status}
              driver={driver}
              hasLocation={!!driverLocation}
              onCancel={() => void handleCancel()}
              cancelling={cancelling}
            />
          )}

          {ride.status === "IN_PROGRESS" && driver && (
            <InProgressContent driver={driver} dropoffZoneName={params.dropoffZoneName} />
          )}

          {ride.status === "COMPLETED" && (
            <CompletedContent
              rideId={ride.id}
              fareSummary={data?.fareSummary}
              onDone={() => router.replace("/")}
            />
          )}

          {ride.status === "CANCELLED" && (
            <View style={styles.cancelledContent}>
              <Text variant="h1" style={styles.centerTitle}>
                Ride cancelled
              </Text>
              <Button label="Back to home" variant="secondary" onPress={() => router.replace("/")} />
            </View>
          )}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

function SearchingContent({
  pickupZoneName,
  dropoffZoneName,
  priceLabel,
  rideType,
  progress,
  canSwitchToLone,
  onSwitchToLone,
  switching,
  onCancel,
  cancelling,
}: {
  pickupZoneName: string;
  dropoffZoneName: string;
  priceLabel: string;
  rideType: string;
  progress: number;
  canSwitchToLone: boolean;
  onSwitchToLone: () => void;
  switching: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <View style={styles.section}>
      <Text variant="h1">Finding your driver</Text>
      <Text variant="bodySmall" color="muted" style={styles.route}>
        {pickupZoneName} → {dropoffZoneName}
      </Text>

      <View style={styles.progressWrap}>
        <ProgressBar progress={progress} />
      </View>

      <Card style={styles.summary}>
        <View style={styles.summaryRow}>
          <Text variant="label" color="muted">
            RIDE TYPE
          </Text>
          <Text variant="bodyMedium">{rideType === "SHARED" ? "Shared" : "Lone"}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text variant="label" color="muted">
            ESTIMATED FARE
          </Text>
          <Text variant="bodyMedium">{priceLabel}</Text>
        </View>
      </Card>

      <View style={styles.buttonGroup}>
        {canSwitchToLone && (
          <Button label="Switch to Lone" variant="secondary" onPress={onSwitchToLone} loading={switching} />
        )}
        <Button label="Cancel request" variant="ghost" onPress={onCancel} loading={cancelling} />
      </View>
    </View>
  );
}

function NoDriverContent({
  canSwitchToLone,
  submitting,
  onAction,
}: {
  canSwitchToLone: boolean;
  submitting: boolean;
  onAction: (action: "KEEP_WAITING" | "SWITCH_TO_LONE" | "CANCEL") => void;
}) {
  return (
    <View style={styles.section}>
      <Text variant="h1">No driver found</Text>
      <Text variant="body" color="muted">
        We couldn't find a driver in time. You can search again, switch to a solo ride, or cancel.
      </Text>

      {submitting ? (
        <LoadingState message="Updating your ride..." />
      ) : (
        <View style={styles.buttonGroup}>
          <Button label="Search again" onPress={() => onAction("KEEP_WAITING")} />
          {canSwitchToLone && (
            <Button label="Switch to Lone" variant="secondary" onPress={() => onAction("SWITCH_TO_LONE")} />
          )}
          <Button label="Cancel ride" variant="danger" onPress={() => onAction("CANCEL")} />
        </View>
      )}
    </View>
  );
}

function DriverCard({ driver }: { driver: RideDriverInfo }) {
  const car = [driver.carColor, driver.carMake, driver.carModel].filter(Boolean).join(" ");
  return (
    <Card style={styles.driverCard}>
      <View style={styles.driverHeader}>
        <Text variant="h3">{driver.name}</Text>
        {driver.rating != null && <Badge label={`★ ${driver.rating.toFixed(1)}`} variant="success" />}
      </View>
      {car && (
        <Text variant="bodySmall" color="muted">
          {car}
        </Text>
      )}
      {driver.plate && (
        <Text variant="bodySmall" color="muted">
          Plate: {driver.plate}
        </Text>
      )}
    </Card>
  );
}

function DriverFoundContent({
  status,
  driver,
  hasLocation,
  onCancel,
  cancelling,
}: {
  status: "MATCHED" | "ARRIVED";
  driver: RideDriverInfo;
  hasLocation: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <View style={styles.section}>
      <Text variant="h1">{status === "ARRIVED" ? "Your driver is here" : "Driver on the way"}</Text>
      {status === "MATCHED" && (
        <Text variant="body" color="muted">
          {hasLocation ? `Your driver is about ${DUMMY_ETA_MINUTES} min away.` : "Your driver is getting ready."}
        </Text>
      )}
      {status === "ARRIVED" && (
        <Text variant="body" color="muted">
          Head to your pickup point — your driver is waiting.
        </Text>
      )}

      <DriverCard driver={driver} />

      <Button label="Cancel ride" variant="secondary" onPress={onCancel} loading={cancelling} />
    </View>
  );
}

function InProgressContent({
  driver,
  dropoffZoneName,
}: {
  driver: RideDriverInfo;
  dropoffZoneName: string;
}) {
  return (
    <View style={styles.section}>
      <Text variant="h1">On your way</Text>
      <Text variant="body" color="muted">
        Heading to {dropoffZoneName} · about {DUMMY_ETA_MINUTES} min away.
      </Text>

      <DriverCard driver={driver} />
    </View>
  );
}

function CompletedContent({
  rideId,
  fareSummary,
  onDone,
}: {
  rideId: string;
  fareSummary: { yourFarePesewas: number; totalFarePesewas: number } | undefined;
  onDone: () => void;
}) {
  const [stars, setStars] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmitRating() {
    if (stars === 0) return;
    setSubmitting(true);
    try {
      await submitRating({ rideId, stars });
      setSubmitted(true);
    } catch {
      Alert.alert("Couldn't submit rating", "Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.section}>
      <Text variant="h1">Ride completed</Text>

      {fareSummary && (
        <Card style={styles.summary}>
          <View style={styles.summaryRow}>
            <Text variant="label" color="muted">
              YOUR FARE
            </Text>
            <Text variant="bodyMedium">{(fareSummary.yourFarePesewas / 100).toFixed(2)} GHS</Text>
          </View>
        </Card>
      )}

      {!submitted ? (
        <>
          <Text variant="bodyMedium">Rate your driver</Text>
          <View style={styles.starsRow}>
            {STARS.map((value) => (
              <Pressable key={value} accessibilityRole="button" onPress={() => setStars(value)}>
                <Text variant="h1" color={value <= stars ? "primary" : "muted"}>
                  ★
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.buttonGroup}>
            <Button
              label="Submit rating"
              onPress={() => void handleSubmitRating()}
              loading={submitting}
              disabled={stars === 0}
            />
            <Button label="Skip" variant="ghost" onPress={onDone} />
          </View>
        </>
      ) : (
        <>
          <Text variant="body" color="muted">
            Thanks for rating your driver!
          </Text>
          <Button label="Back to home" onPress={onDone} />
        </>
      )}
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
    gap: spacing.lg,
  },
  section: { gap: spacing.md },
  route: { marginTop: -spacing.xs },
  progressWrap: { marginVertical: spacing.xs },
  summary: { gap: spacing.md },
  summaryRow: { gap: spacing.xs },
  buttonGroup: { gap: spacing.md, marginTop: spacing.sm },
  driverCard: { gap: spacing.xs },
  driverHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  starsRow: { flexDirection: "row", gap: spacing.sm },
  cancelledContent: { alignItems: "center", gap: spacing.lg, paddingVertical: spacing.xl },
  centerTitle: { textAlign: "center" },
});
