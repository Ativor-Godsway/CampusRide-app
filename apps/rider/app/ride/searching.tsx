import { useMemo, useState } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import {
  Badge,
  Button,
  Card,
  LoadingState,
  MapboxStaticMap,
  Screen,
  Text,
  cancelRide,
  colors,
  getMapboxToken,
  spacing,
  submitRating,
  submitRideDecision,
  useDriverLocation,
  useRideTracking,
  type RideDriverInfo,
} from "@rida/mobile-shared";

type MapMarker = { id: string; latitude: number; longitude: number; label?: string; selected?: boolean };

const DUMMY_ETA_MINUTES = 4;
const MAP_HEIGHT = 220;
const STARS = [1, 2, 3, 4, 5];

export default function SearchingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    rideId: string;
    type: string;
    pickupZoneName: string;
    dropoffZoneName: string;
    priceLabel: string;
  }>();

  const { width: windowWidth } = useWindowDimensions();
  const mapboxToken = getMapboxToken();
  const mapWidth = windowWidth - spacing.xl * 2;

  const { data, isLoading } = useRideTracking(params.rideId);
  const [driverLocation, setDriverLocation] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );
  const [decisionSubmitting, setDecisionSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useDriverLocation(params.rideId, (payload) => {
    setDriverLocation({ latitude: payload.lat, longitude: payload.lng });
  });

  const ride = data?.ride;
  const driver = data?.driver;

  const center = useMemo(() => {
    if (!ride) return null;
    return {
      latitude: (ride.pickupZone.latitude + ride.dropoffZone.latitude) / 2,
      longitude: (ride.pickupZone.longitude + ride.dropoffZone.longitude) / 2,
    };
  }, [ride]);

  const markers = useMemo(() => {
    if (!ride) return [];
    const list = [
      { id: "pickup", latitude: ride.pickupZone.latitude, longitude: ride.pickupZone.longitude, label: "Pickup" },
      { id: "dropoff", latitude: ride.dropoffZone.latitude, longitude: ride.dropoffZone.longitude, label: "Dropoff", selected: true },
    ];
    if (driverLocation) {
      list.push({ id: "driver", ...driverLocation, label: "Driver" });
    }
    return list;
  }, [ride, driverLocation]);

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

  if (isLoading || !ride) {
    return (
      <Screen>
        <LoadingState message="Loading your ride..." />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {ride.status === "REQUESTED" && (
        <SearchingState
          pickupZoneName={params.pickupZoneName}
          dropoffZoneName={params.dropoffZoneName}
          priceLabel={params.priceLabel}
          type={params.type}
          onCancel={() => void handleCancel()}
          cancelling={cancelling}
        />
      )}

      {ride.status === "AWAITING_RIDER_DECISION" && (
        <DecisionState
          canSwitchToLone={ride.type === "SHARED" && ride.occupancy === 1}
          submitting={decisionSubmitting}
          onAction={(action) => void handleDecision(action)}
        />
      )}

      {(ride.status === "MATCHED" || ride.status === "ARRIVED") && driver && (
        <DriverEnRouteState
          status={ride.status}
          driver={driver}
          center={center}
          markers={markers}
          mapWidth={mapWidth}
          mapboxToken={mapboxToken}
          hasLocation={!!driverLocation}
          onCancel={() => void handleCancel()}
          cancelling={cancelling}
        />
      )}

      {ride.status === "IN_PROGRESS" && driver && (
        <InProgressState
          driver={driver}
          center={center}
          markers={markers}
          mapWidth={mapWidth}
          mapboxToken={mapboxToken}
          dropoffZoneName={params.dropoffZoneName}
        />
      )}

      {ride.status === "COMPLETED" && (
        <CompletedState
          rideId={ride.id}
          fareSummary={data?.fareSummary}
          onDone={() => router.replace("/")}
        />
      )}

      {ride.status === "CANCELLED" && (
        <View style={styles.center}>
          <Text variant="h1" style={styles.centerTitle}>
            Ride cancelled
          </Text>
          <Button label="Back to home" variant="secondary" onPress={() => router.replace("/")} />
        </View>
      )}
    </Screen>
  );
}

function SearchingState({
  pickupZoneName,
  dropoffZoneName,
  priceLabel,
  type,
  onCancel,
  cancelling,
}: {
  pickupZoneName: string;
  dropoffZoneName: string;
  priceLabel: string;
  type: string;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <View style={styles.content}>
      <ActivityIndicator size="large" color={colors.primary[500]} />
      <Text variant="h1" style={styles.title}>
        Searching for a driver...
      </Text>
      <Text variant="body" color="muted" style={styles.subtitle}>
        We'll match you with a nearby driver. This usually takes a minute or two.
      </Text>

      <Card style={styles.summary}>
        <View style={styles.summaryRow}>
          <Text variant="label" color="muted">
            ROUTE
          </Text>
          <Text variant="bodyMedium">
            {pickupZoneName} → {dropoffZoneName}
          </Text>
        </View>
        <View style={styles.summaryRow}>
          <Text variant="label" color="muted">
            RIDE TYPE
          </Text>
          <Text variant="bodyMedium">{type === "SHARED" ? "Shared" : "Lone"}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text variant="label" color="muted">
            ESTIMATED FARE
          </Text>
          <Text variant="bodyMedium">{priceLabel}</Text>
        </View>
      </Card>

      <Button label="Cancel request" variant="secondary" onPress={onCancel} loading={cancelling} />
    </View>
  );
}

function DecisionState({
  canSwitchToLone,
  submitting,
  onAction,
}: {
  canSwitchToLone: boolean;
  submitting: boolean;
  onAction: (action: "KEEP_WAITING" | "SWITCH_TO_LONE" | "CANCEL") => void;
}) {
  return (
    <View style={styles.content}>
      <Text variant="h1" style={styles.title}>
        Still looking...
      </Text>
      <Text variant="body" color="muted" style={styles.subtitle}>
        We haven't found a driver yet. You can keep waiting, switch to a solo ride, or cancel.
      </Text>

      {submitting ? (
        <LoadingState message="Updating your ride..." />
      ) : (
        <View style={styles.decisionButtons}>
          <Button label="Keep waiting" onPress={() => onAction("KEEP_WAITING")} />
          {canSwitchToLone && (
            <Button
              label="Switch to solo ride"
              variant="secondary"
              onPress={() => onAction("SWITCH_TO_LONE")}
            />
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

function MapBlock({
  mapboxToken,
  center,
  markers,
  mapWidth,
}: {
  mapboxToken: string | undefined;
  center: { latitude: number; longitude: number } | null;
  markers: MapMarker[];
  mapWidth: number;
}) {
  if (!mapboxToken || !center) return null;
  return (
    <View style={styles.mapWrapper}>
      <MapboxStaticMap
        accessToken={mapboxToken}
        center={center}
        width={mapWidth}
        height={MAP_HEIGHT}
        markers={markers}
      />
    </View>
  );
}

function DriverEnRouteState({
  status,
  driver,
  center,
  markers,
  mapWidth,
  mapboxToken,
  hasLocation,
  onCancel,
  cancelling,
}: {
  status: "MATCHED" | "ARRIVED";
  driver: RideDriverInfo;
  center: { latitude: number; longitude: number } | null;
  markers: MapMarker[];
  mapWidth: number;
  mapboxToken: string | undefined;
  hasLocation: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <View style={styles.content}>
      <Text variant="h1" style={styles.title}>
        {status === "ARRIVED" ? "Your driver is here" : "Driver on the way"}
      </Text>
      {status === "MATCHED" && (
        <Text variant="body" color="muted" style={styles.subtitle}>
          {hasLocation ? `Your driver is about ${DUMMY_ETA_MINUTES} min away.` : "Your driver is getting ready."}
        </Text>
      )}
      {status === "ARRIVED" && (
        <Text variant="body" color="muted" style={styles.subtitle}>
          Head to your pickup point — your driver is waiting.
        </Text>
      )}

      <DriverCard driver={driver} />
      <MapBlock mapboxToken={mapboxToken} center={center} markers={markers} mapWidth={mapWidth} />

      <Button label="Cancel ride" variant="secondary" onPress={onCancel} loading={cancelling} />
    </View>
  );
}

function InProgressState({
  driver,
  center,
  markers,
  mapWidth,
  mapboxToken,
  dropoffZoneName,
}: {
  driver: RideDriverInfo;
  center: { latitude: number; longitude: number } | null;
  markers: MapMarker[];
  mapWidth: number;
  mapboxToken: string | undefined;
  dropoffZoneName: string;
}) {
  return (
    <View style={styles.content}>
      <Text variant="h1" style={styles.title}>
        On your way
      </Text>
      <Text variant="body" color="muted" style={styles.subtitle}>
        Heading to {dropoffZoneName}.
      </Text>

      <DriverCard driver={driver} />
      <MapBlock mapboxToken={mapboxToken} center={center} markers={markers} mapWidth={mapWidth} />
    </View>
  );
}

function CompletedState({
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
    <View style={styles.content}>
      <Text variant="h1" style={styles.title}>
        Ride completed
      </Text>

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
          <Text variant="bodyMedium" style={styles.subtitle}>
            Rate your driver
          </Text>
          <View style={styles.starsRow}>
            {STARS.map((value) => (
              <Pressable key={value} accessibilityRole="button" onPress={() => setStars(value)}>
                <Text variant="h1" color={value <= stars ? "primary" : "muted"}>
                  ★
                </Text>
              </Pressable>
            ))}
          </View>
          <Button
            label="Submit rating"
            onPress={() => void handleSubmitRating()}
            loading={submitting}
            disabled={stars === 0}
          />
          <Button label="Skip" variant="ghost" onPress={onDone} />
        </>
      ) : (
        <>
          <Text variant="body" color="muted" style={styles.subtitle}>
            Thanks for rating your driver!
          </Text>
          <Button label="Back to home" onPress={onDone} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.md },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.lg },
  centerTitle: { textAlign: "center" },
  title: { textAlign: "center", marginTop: spacing.lg },
  subtitle: { textAlign: "center", marginBottom: spacing.lg },
  summary: { width: "100%", gap: spacing.md, marginBottom: spacing.xl },
  summaryRow: { gap: spacing.xs },
  decisionButtons: { width: "100%", gap: spacing.md },
  driverCard: { width: "100%", gap: spacing.xs },
  driverHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  mapWrapper: { width: "100%", marginVertical: spacing.lg },
  starsRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
});
