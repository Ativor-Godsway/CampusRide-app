import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import type { PaymentMethod, RideCompletedFareSummary, RideType } from "@rida/shared";
import { getSharedFarePerRider, priceLoneRide } from "@rida/shared";
import {
  ActiveRideExistsError,
  Badge,
  Button,
  Card,
  CampusMapView,
  type CampusMapZone,
  Input,
  LoadingState,
  type MoolreNetwork,
  ProgressBar,
  ServiceIcon,
  Text,
  cancelRide,
  colors,
  createRide,
  formatGhs,
  initiateRidePayment,
  pollPaymentStatus,
  radii,
  regionForCoordinates,
  rideQueryKey,
  RouteStops,
  spacing,
  submitRating,
  submitRideDecision,
  typography,
  useAuth,
  useDriverLocation,
  useRideTracking,
  type RideDriverInfo,
} from "@rida/mobile-shared";

const BROADCAST_WINDOW_MS = 90_000;
const DUMMY_ETA_MINUTES = 4;
const STARS = [1, 2, 3, 4, 5];
const SEARCHING_MESSAGES = [
  "Finding your driver…",
  "Connecting you with nearby drivers…",
  "Reaching out to drivers near you…",
  "Hang tight, almost there…",
] as const;

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
    /** Present when resuming an active ride from the "Your rides" tab. */
    rideId?: string;
  }>();

  // ── Options phase ───────────────────────────────────────────────────────────
  const [selectedType, setSelectedType] = useState<RideType>("SHARED");
  const [expandedType, setExpandedType] = useState<RideType | null>(null);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethod>("MOMO");
  const [submitting, setSubmitting] = useState(false);

  // ── Tracking phase (null = options phase, string = post-request or resume) ───
  const [activeRideId, setActiveRideId] = useState<string | null>(params.rideId ?? null);
  const [driverLocation, setDriverLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [decisionSubmitting, setDecisionSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: trackingData } = useRideTracking(activeRideId ?? undefined);

  useDriverLocation(activeRideId ?? undefined, (payload) => {
    setDriverLocation({ latitude: payload.lat, longitude: payload.lng });
  });

  const ride = trackingData?.ride;
  const driver = trackingData?.driver;
  // Phase 6b-3: this rider's own RidePassenger row.
  const myPassenger = ride?.passengers.find((p) => p.riderId === user?.id);
  /**
   * The rider's own leg status, purely own-trip — never derived from
   * co-passengers or any "another passenger" concept. For SHARED rides this
   * is exactly `myPassenger.status` (the driver app writes WAITING -> ARRIVED
   * -> PICKED_UP -> DROPPED_OFF independently per passenger). LONE rides
   * never write per-passenger status (it stays WAITING forever in the DB) —
   * for LONE only, this is derived from the ride-level status instead, which
   * remains the correct source of truth there.
   */
  const myLegStatus: "WAITING" | "ARRIVED" | "PICKED_UP" | "DROPPED_OFF" =
    ride?.type === "LONE"
      ? ride.status === "ARRIVED"
        ? "ARRIVED"
        : ride.status === "IN_PROGRESS"
          ? "PICKED_UP"
          : "WAITING"
      : myPassenger?.status === "ARRIVED" ||
          myPassenger?.status === "PICKED_UP" ||
          myPassenger?.status === "DROPPED_OFF"
        ? myPassenger.status
        : "WAITING";

  useEffect(() => {
    if (ride?.status !== "REQUESTED") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [ride?.status]);

  // #7 merged-rider reach: this request may have been absorbed into another
  // driver's car (CANCELLED / MERGED_INTO_ANOTHER_RIDE). Follow the pointer to
  // the anchor ride so useRideTracking listens on the correct room and
  // per-passenger events reach us. Anchor riders never hit this (their ride is
  // never merged).
  const isMerged =
    ride?.status === "CANCELLED" &&
    ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE" &&
    !!ride.mergedIntoRideId;

  useEffect(() => {
    if (isMerged && ride?.mergedIntoRideId && ride.mergedIntoRideId !== activeRideId) {
      setActiveRideId(ride.mergedIntoRideId);
    }
  }, [isMerged, ride?.mergedIntoRideId, activeRideId]);

  // ── Fares ───────────────────────────────────────────────────────────────────
  // Flat per-rider SHARED fare — getSharedFarePerRider(occupancy) now returns
  // the same 500 pesewas regardless of which occupancy (1-4) is passed in.
  const sharedFare = useMemo(() => getSharedFarePerRider(1), []);
  const loneFare = useMemo(() => priceLoneRide().fare, []);

  const options: RideOption[] = useMemo(
    () => [
      {
        type: "SHARED",
        title: "Shared",
        priceLabel: formatGhs(sharedFare),
        summary: "Share with others & save",
        details: "GHS 5 each, every time. Share with others heading your way.",
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
    [sharedFare, loneFare],
  );

  // ── Map coords & region ─────────────────────────────────────────────────────
  const pickupCoord = useMemo(
    () => ({ latitude: Number(params.pickupLat), longitude: Number(params.pickupLng) }),
    [params.pickupLat, params.pickupLng],
  );
  const dropoffCoord = useMemo(
    () => ({ latitude: Number(params.dropoffLat), longitude: Number(params.dropoffLng) }),
    [params.dropoffLat, params.dropoffLng],
  );

  const region = useMemo(() => {
    const points = [pickupCoord, dropoffCoord];
    if (driverLocation) points.push(driverLocation);
    return regionForCoordinates(points, 0.8);
  }, [pickupCoord, dropoffCoord, driverLocation]);

  const mapZones = useMemo(() => {
    const zones: CampusMapZone[] = [
      { id: "pickup", ...pickupCoord, label: params.pickupZoneName, role: "pickup" },
      { id: "dropoff", ...dropoffCoord, label: params.dropoffZoneName, role: "dropoff" },
    ];
    if (driverLocation) {
      zones.push({ id: "driver", ...driverLocation, label: "Driver" });
    }
    return zones;
  }, [pickupCoord, dropoffCoord, driverLocation, params.pickupZoneName, params.dropoffZoneName]);

  // ── Search progress ─────────────────────────────────────────────────────────
  const searchProgress = useMemo(() => {
    if (!ride?.broadcastStartedAt) return 1;
    const start = new Date(ride.broadcastStartedAt).getTime();
    const elapsed = now - start;
    return Math.max(0, Math.min(1, 1 - elapsed / BROADCAST_WINDOW_MS));
  }, [ride?.broadcastStartedAt, now]);

  const priceLabel = selectedType === "SHARED" ? formatGhs(sharedFare) : formatGhs(loneFare);

  const canSwitchToLone = ride?.type === "SHARED" && ride?.occupancy === 1;

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!params.pickupZoneId || !params.dropoffZoneId) return;
    setSubmitting(true);
    try {
      const created = await createRide({
        pickupZoneId: params.pickupZoneId,
        dropoffZoneId: params.dropoffZoneId,
        type: selectedType,
        paymentMethod: selectedPaymentMethod,
      });
      setActiveRideId(created.id);
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

  async function handleDecision(action: "KEEP_WAITING" | "SWITCH_TO_LONE" | "CANCEL") {
    if (!activeRideId) return;
    setDecisionSubmitting(true);
    try {
      await submitRideDecision(activeRideId, action);
      if (action === "CANCEL") {
        router.replace("/");
      } else {
        // Refetch so broadcastStartedAt is fresh for the restarted slider.
        await queryClient.invalidateQueries({ queryKey: rideQueryKey(activeRideId) });
      }
    } catch {
      Alert.alert("Something went wrong", "Please try again.");
    } finally {
      setDecisionSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!activeRideId) return;
    setCancelling(true);
    try {
      await cancelRide(activeRideId);
      router.replace("/");
    } catch {
      Alert.alert("Couldn't cancel", "Please try again.");
    } finally {
      setCancelling(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
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
          {activeRideId === null && (
            <OptionsContent
              options={options}
              selectedType={selectedType}
              expandedType={expandedType}
              onSelectType={setSelectedType}
              onToggleExpand={(t) => setExpandedType((e) => (e === t ? null : t))}
              selectedPaymentMethod={selectedPaymentMethod}
              onSelectPaymentMethod={setSelectedPaymentMethod}
              pickupZoneName={params.pickupZoneName}
              dropoffZoneName={params.dropoffZoneName}
              submitting={submitting}
              onSubmit={() => void handleSubmit()}
            />
          )}

          {activeRideId !== null &&
            (myPassenger?.status === "CANCELLED" ? (
              <CancelledContent
                onDone={() => router.replace("/")}
                title="Driver cancelled"
                message="Your driver cancelled your pickup. Please request a ride again."
              />
            ) : (
            <>
              {(!ride || ride.status === "REQUESTED" || isMerged) && (
                <SearchingContent
                  pickupZoneName={params.pickupZoneName}
                  dropoffZoneName={params.dropoffZoneName}
                  priceLabel={priceLabel}
                  rideType={selectedType}
                  progress={ride ? searchProgress : 1}
                  onCancel={() => void handleCancel()}
                  cancelling={cancelling}
                />
              )}

              {ride?.status === "AWAITING_RIDER_DECISION" && (
                <NoDriverContent
                  canSwitchToLone={canSwitchToLone ?? false}
                  submitting={decisionSubmitting}
                  onAction={(action) => void handleDecision(action)}
                />
              )}

              {(ride?.status === "MATCHED" ||
                ride?.status === "ARRIVED" ||
                ride?.status === "IN_PROGRESS") &&
                driver &&
                (myLegStatus === "DROPPED_OFF" ? (
                  <MyLegDoneContent dropoffZoneName={params.dropoffZoneName} />
                ) : myLegStatus === "PICKED_UP" ? (
                  <InProgressContent driver={driver} dropoffZoneName={params.dropoffZoneName} />
                ) : (
                  <DriverFoundContent
                    arrived={myLegStatus === "ARRIVED"}
                    driver={driver}
                    hasLocation={!!driverLocation}
                    onCancel={() => void handleCancel()}
                    cancelling={cancelling}
                  />
                ))}

              {ride?.status === "COMPLETED" && (
                <CompletedContent
                  rideId={ride.id}
                  rideType={ride.type}
                  fareSummary={trackingData?.fareSummary}
                  onDone={() => router.replace("/")}
                />
              )}

              {ride?.status === "CANCELLED" && !isMerged && (
                <CancelledContent onDone={() => router.replace("/")} />
              )}
            </>
            ))}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

// ── Options phase ─────────────────────────────────────────────────────────────

const PAYMENT_METHOD_OPTIONS: { value: PaymentMethod; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: "MOMO", label: "MoMo", icon: "phone-portrait-outline" },
  { value: "CASH", label: "Cash", icon: "cash-outline" },
];

function OptionsContent({
  options,
  selectedType,
  expandedType,
  onSelectType,
  onToggleExpand,
  selectedPaymentMethod,
  onSelectPaymentMethod,
  pickupZoneName,
  dropoffZoneName,
  submitting,
  onSubmit,
}: {
  options: RideOption[];
  selectedType: RideType;
  expandedType: RideType | null;
  onSelectType: (t: RideType) => void;
  onToggleExpand: (t: RideType) => void;
  selectedPaymentMethod: PaymentMethod;
  onSelectPaymentMethod: (m: PaymentMethod) => void;
  pickupZoneName: string;
  dropoffZoneName: string;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      <Text variant="h1">Choose your ride</Text>

      <RouteStops
        style={styles.route}
        connectorHeight={14}
        origin={
          <Text variant="bodySmall" numberOfLines={1}>
            {pickupZoneName}
          </Text>
        }
        destination={
          <Text variant="bodySmall" numberOfLines={1}>
            {dropoffZoneName}
          </Text>
        }
      />

      {options.map((option) => {
        const isSelected = selectedType === option.type;
        const isExpanded = expandedType === option.type;
        return (
          <Pressable
            key={option.type}
            accessibilityRole="button"
            onPress={() => onSelectType(option.type)}
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
                  onPress={() => onToggleExpand(option.type)}
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

      <View style={styles.paymentSection}>
        <Text variant="label" color="muted">
          PAYMENT METHOD
        </Text>
        <View style={styles.paymentRow}>
          {PAYMENT_METHOD_OPTIONS.map((opt) => {
            const selected = selectedPaymentMethod === opt.value;
            return (
              <Pressable
                key={opt.value}
                accessibilityRole="button"
                onPress={() => onSelectPaymentMethod(opt.value)}
                style={[styles.paymentOption, selected && styles.paymentOptionSelected]}
              >
                <Ionicons
                  name={opt.icon}
                  size={18}
                  color={selected ? colors.primary[600] : colors.ink[400]}
                />
                <Text variant="bodySmall" color={selected ? "primary" : "muted"}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.footer}>
        {submitting ? (
          <LoadingState message="Requesting your ride..." />
        ) : (
          <Button
            label={selectedType === "SHARED" ? "Request shared ride" : "Request solo ride"}
            onPress={onSubmit}
          />
        )}
      </View>
    </>
  );
}

// ── Tracking phase content ────────────────────────────────────────────────────

function SearchingContent({
  pickupZoneName,
  dropoffZoneName,
  priceLabel,
  rideType,
  progress,
  onCancel,
  cancelling,
}: {
  pickupZoneName: string;
  dropoffZoneName: string;
  priceLabel: string;
  rideType: RideType;
  progress: number;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      () => setMsgIdx((i) => (i + 1) % SEARCHING_MESSAGES.length),
      20000,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon name="search" size={48} iconSize={22} />
        <View style={styles.stateHeading}>
          <Text variant="h2">{SEARCHING_MESSAGES[msgIdx]}</Text>
          <Text variant="bodySmall" color="muted">
            {pickupZoneName} → {dropoffZoneName}
          </Text>
        </View>
      </View>

      <View style={styles.progressSection}>
        <ProgressBar progress={progress} />
        <Text variant="caption" color="subtle" style={styles.progressLabel}>
          Contacting available drivers nearby
        </Text>
      </View>

      <Card style={styles.infoCard}>
        <View style={styles.infoRow}>
          <Ionicons name="car-outline" size={16} color={colors.ink[400]} />
          <Text variant="bodySmall" color="muted" style={styles.infoLabel}>
            {rideType === "SHARED" ? "Shared ride" : "Solo ride"}
          </Text>
          <Text variant="bodySmall">{priceLabel}</Text>
        </View>
      </Card>

      <View style={styles.buttonGroup}>
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
      <View style={styles.stateHeader}>
        <ServiceIcon
          name="alert-circle-outline"
          size={48}
          iconSize={22}
          background={colors.warningSurface}
          color={colors.warning}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">No drivers available right now</Text>
          <Text variant="bodySmall" color="muted">
            Try again — campus driver availability changes quickly.
          </Text>
        </View>
      </View>

      {submitting ? (
        <LoadingState message="Updating your ride..." />
      ) : (
        <View style={styles.buttonGroup}>
          <Button label="Search again" onPress={() => onAction("KEEP_WAITING")} />
          {canSwitchToLone && (
            <Button
              label="Switch to solo ride"
              variant="secondary"
              onPress={() => onAction("SWITCH_TO_LONE")}
            />
          )}
          <Button label="Cancel" variant="ghost" onPress={() => onAction("CANCEL")} />
        </View>
      )}
    </View>
  );
}

function DriverAvatar({ name }: { name: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <View style={styles.avatar}>
      <Text variant="h3" color="inverse">
        {initials}
      </Text>
    </View>
  );
}

function PremiumDriverCard({ driver }: { driver: RideDriverInfo }) {
  const car = [driver.carColor, driver.carMake, driver.carModel].filter(Boolean).join(" ");
  return (
    <Card style={styles.driverCard}>
      <View style={styles.driverRow}>
        <DriverAvatar name={driver.name} />
        <View style={styles.driverInfo}>
          <Text variant="h3">{driver.name}</Text>
          {driver.rating != null && (
            <View style={styles.ratingRow}>
              <Ionicons name="star" size={13} color={colors.accent[500]} />
              <Text variant="bodySmall" color="muted">
                {" "}
                {driver.rating.toFixed(1)}
              </Text>
            </View>
          )}
          {car ? (
            <Text variant="bodySmall" color="muted">
              {car}
            </Text>
          ) : null}
        </View>
        {driver.plate ? (
          <View style={styles.plateBadge}>
            <Text variant="mono" style={{ fontSize: 12 }}>{driver.plate}</Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function DriverFoundContent({
  arrived,
  driver,
  hasLocation,
  onCancel,
  cancelling,
}: {
  /** Ride-level ARRIVED (LONE) OR this rider's own passenger row is ARRIVED
   * (SHARED, Phase 6b-3 — the ride itself may still be MATCHED if this
   * passenger's pickup is the car's first). */
  arrived: boolean;
  driver: RideDriverInfo;
  hasLocation: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon
          name={arrived ? "flag" : "car"}
          size={48}
          iconSize={22}
          background={arrived ? colors.successSurface : colors.primary[50]}
          color={arrived ? colors.success : colors.primary[600]}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">{arrived ? "Your driver has arrived" : "Driver is on the way to you"}</Text>
          <Text variant="bodySmall" color="muted">
            {arrived
              ? "Head to your pickup point — your driver is waiting."
              : hasLocation
                ? `About ${DUMMY_ETA_MINUTES} min away`
                : "Your driver is getting ready"}
          </Text>
        </View>
      </View>

      <PremiumDriverCard driver={driver} />

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
      <View style={styles.stateHeader}>
        <ServiceIcon name="navigate" size={48} iconSize={22} />
        <View style={styles.stateHeading}>
          <Text variant="h2">On your way</Text>
          <Text variant="bodySmall" color="muted">
            Heading to {dropoffZoneName} · ~{DUMMY_ETA_MINUTES} min
          </Text>
        </View>
      </View>

      <PremiumDriverCard driver={driver} />
    </View>
  );
}

/**
 * Phase 6b-3: shown once THIS rider's own passenger row is DROPPED_OFF, even
 * if the overall ride isn't COMPLETED yet (other passengers may still be
 * riding). No fare/rating here — that needs the ride-level fareSummary,
 * which the backend only computes once the whole ride completes; this is
 * purely a "your leg is done" acknowledgement in the meantime.
 */
function MyLegDoneContent({ dropoffZoneName }: { dropoffZoneName: string }) {
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon
          name="checkmark-circle"
          size={48}
          iconSize={22}
          background={colors.successSurface}
          color={colors.success}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">You're at {dropoffZoneName}</Text>
          <Text variant="bodySmall" color="muted">
            Wrapping up the rest of the trip — your fare summary will appear shortly.
          </Text>
        </View>
      </View>
    </View>
  );
}

type MomoPhase = "form" | "otp" | "waiting" | "confirmed" | "failed";

function RatingPanel({
  rideId,
  onDone,
}: {
  rideId: string;
  onDone: () => void;
}) {
  const [stars, setStars] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
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

  if (submitted) {
    return (
      <>
        <Text variant="body" color="muted">
          Thanks for rating your driver!
        </Text>
        <Button label="Back to home" onPress={onDone} />
      </>
    );
  }

  return (
    <>
      <View style={styles.ratingSection}>
        <Text variant="bodyMedium">How was your ride?</Text>
        <View style={styles.starsRow}>
          {STARS.map((value) => (
            <Pressable key={value} accessibilityRole="button" onPress={() => setStars(value)}>
              <Ionicons
                name={value <= stars ? "star" : "star-outline"}
                size={36}
                color={value <= stars ? colors.accent[500] : colors.ink[200]}
              />
            </Pressable>
          ))}
        </View>
      </View>
      <View style={styles.buttonGroup}>
        <Button
          label="Submit rating"
          onPress={() => void handleSubmit()}
          loading={submitting}
          disabled={stars === 0}
        />
        <Button label="Skip" variant="ghost" onPress={onDone} />
      </View>
    </>
  );
}

/** Mint "shared & saved" note — purely presentational, derived from the existing flat lone-fare constant. */
function SharedSavingsNote({ amountPesewas }: { amountPesewas: number }) {
  return (
    <View style={styles.savingsNote}>
      <Ionicons name="people" size={14} color={colors.success} />
      <Text variant="bodySmall" style={styles.savingsNoteText}>
        Shared ride — you saved {formatGhs(amountPesewas)} vs. lone
      </Text>
    </View>
  );
}

function CompletedContent({
  rideId,
  rideType,
  fareSummary,
  onDone,
}: {
  rideId: string;
  rideType: RideType;
  fareSummary: RideCompletedFareSummary | undefined;
  onDone: () => void;
}) {
  const [momoPhase, setMomoPhase] = useState<MomoPhase>("form");
  const [phone, setPhone] = useState("");
  const [network, setNetwork] = useState<MoolreNetwork>("MTN");
  const [paying, setPaying] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [confirmingOtp, setConfirmingOtp] = useState(false);
  const [otpExpired, setOtpExpired] = useState(false);
  const [ratingReady, setRatingReady] = useState(false);

  // Sync momo phase from server-provided status when fareSummary arrives.
  // NOTE: fareSummary.paymentStatus has no AWAITING_OTP bucket (deferred 3b
  // TODO — see paymentFlow.ts's getRidePaymentSummary), so a remount can't
  // auto-resume into the "otp" phase from this effect; the rider has to tap
  // Pay again, which safely re-surfaces OTP_SENT without re-charging (see
  // handlePay). Immediate post-3c follow-up if poll-based OTP awareness is needed.
  useEffect(() => {
    if (!fareSummary || fareSummary.paymentMethod !== "MOMO") return;
    if (fareSummary.paymentStatus === "COLLECTED" || fareSummary.paymentStatus === "DISBURSED") {
      setMomoPhase("confirmed");
    } else if (fareSummary.paymentStatus === "FAILED") {
      setMomoPhase("failed");
    }
  }, [fareSummary?.paymentStatus, fareSummary?.paymentMethod]);

  // Poll Moolre while waiting for the push-prompt approval
  useEffect(() => {
    if (momoPhase !== "waiting") return;
    const interval = setInterval(() => {
      void pollPaymentStatus(rideId).then(({ paymentStatus }) => {
        if (paymentStatus === "COLLECTED" || paymentStatus === "DISBURSED") {
          setMomoPhase("confirmed");
        } else if (paymentStatus === "FAILED") {
          setMomoPhase("failed");
        }
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [momoPhase, rideId]);

  async function handlePay() {
    if (!phone.trim()) {
      Alert.alert("Phone required", "Enter your MoMo number to continue.");
      return;
    }
    setPaying(true);
    try {
      const { otpStage } = await initiateRidePayment(rideId, phone.trim(), network);
      if (otpStage === "OTP_SENT") {
        setOtpExpired(false);
        setOtpError(null);
        setOtpCode("");
        setMomoPhase("otp");
      } else {
        // "SUBMITTED" or null — no OTP needed (or already confirmed elsewhere).
        setMomoPhase("waiting");
      }
    } catch {
      Alert.alert("Couldn't initiate payment", "Please check your connection and try again.");
    } finally {
      setPaying(false);
    }
  }

  async function handleConfirmOtp() {
    if (otpCode.trim().length !== 6) {
      setOtpError("Enter the 6-digit code");
      return;
    }
    setOtpError(null);
    setConfirmingOtp(true);
    try {
      const { otpStage } = await initiateRidePayment(rideId, phone.trim(), network, otpCode.trim());
      if (otpStage === "OTP_RETRY") {
        setOtpCode("");
        setOtpError("That code didn't match. Check your messages and try again.");
      } else {
        // "SUBMITTED" — correct code accepted (or otherwise resolved) — await confirmation.
        setMomoPhase("waiting");
      }
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        setOtpExpired(true);
        setOtpError("This payment's confirmation window has closed. Tap Pay to start again.");
      } else {
        // Keep the entered code — a flaky network shouldn't make them retype it.
        setOtpError("Couldn't confirm your code. Please check your connection and try again.");
      }
    } finally {
      setConfirmingOtp(false);
    }
  }

  function handleRestartOtp() {
    setOtpExpired(false);
    setOtpError(null);
    setOtpCode("");
    setMomoPhase("form");
  }

  if (!fareSummary) {
    return (
      <View style={styles.section}>
        <LoadingState />
      </View>
    );
  }

  const { yourFarePesewas, paymentMethod } = fareSummary;
  const savingsPesewas =
    rideType === "SHARED" ? Math.max(0, priceLoneRide().fare - yourFarePesewas) : 0;

  // ── Rating screen (shared by both paths after payment) ───────────────────────
  if (ratingReady) {
    return (
      <View style={styles.section}>
        <View style={styles.stateHeader}>
          <ServiceIcon
            name="checkmark-circle"
            size={48}
            iconSize={22}
            background={colors.successSurface}
            color={colors.success}
          />
          <View style={styles.stateHeading}>
            <Text variant="h2">Ride completed</Text>
          </View>
        </View>
        <RatingPanel rideId={rideId} onDone={onDone} />
      </View>
    );
  }

  // ── CASH path ────────────────────────────────────────────────────────────────
  if (paymentMethod === "CASH") {
    return (
      <View style={styles.section}>
        <View style={styles.stateHeader}>
          <ServiceIcon
            name="checkmark-circle"
            size={48}
            iconSize={22}
            background={colors.successSurface}
            color={colors.success}
          />
          <View style={styles.stateHeading}>
            <Text variant="h2">Ride completed</Text>
            <Text variant="bodySmall" color="muted">
              Your fare: {formatGhs(yourFarePesewas)}
            </Text>
          </View>
        </View>
        {savingsPesewas > 0 && <SharedSavingsNote amountPesewas={savingsPesewas} />}
        <Card style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Ionicons name="cash-outline" size={16} color={colors.ink[400]} />
            <Text variant="bodySmall" style={styles.infoLabel}>
              Please pay {formatGhs(yourFarePesewas)} to your driver in cash.
            </Text>
          </View>
        </Card>
        <Button label="Done — rate your driver" onPress={() => setRatingReady(true)} />
      </View>
    );
  }

  // ── MOMO path — payment form ─────────────────────────────────────────────────
  if (momoPhase === "form" || momoPhase === "failed") {
    return (
      <View style={styles.section}>
        <View style={styles.stateHeader}>
          <ServiceIcon
            name="phone-portrait-outline"
            size={48}
            iconSize={22}
            background={colors.primary[50]}
            color={colors.primary[600]}
          />
          <View style={styles.stateHeading}>
            <Text variant="h2">Pay with MoMo</Text>
            <Text variant="bodySmall" color="muted">
              {formatGhs(yourFarePesewas)} will be charged to your wallet.
            </Text>
          </View>
        </View>
        {momoPhase === "failed" && (
          <Card style={styles.errorCard}>
            <Text variant="bodySmall" color="error">
              Payment failed. Check your balance and try again.
            </Text>
          </Card>
        )}
        <Input
          label="MoMo phone number"
          placeholder="+233..."
          value={phone}
          onChangeText={setPhone}
          returnKeyType="done"
        />
        <View style={styles.networkRow}>
          {(["MTN", "TELECEL", "AT"] as MoolreNetwork[]).map((n) => (
            <Pressable
              key={n}
              accessibilityRole="button"
              onPress={() => setNetwork(n)}
              style={[styles.networkOption, network === n && styles.networkOptionSelected]}
            >
              <Text variant="bodySmall" color={network === n ? "primary" : "muted"}>
                {n}
              </Text>
            </Pressable>
          ))}
        </View>
        <Button
          label={`Pay ${formatGhs(yourFarePesewas)}`}
          onPress={() => void handlePay()}
          loading={paying}
        />
      </View>
    );
  }

  // ── MOMO path — OTP entry ─────────────────────────────────────────────────────
  if (momoPhase === "otp") {
    return (
      <View style={styles.section}>
        <View style={styles.stateHeader}>
          <ServiceIcon
            name="key-outline"
            size={48}
            iconSize={22}
            background={colors.primary[50]}
            color={colors.primary[600]}
          />
          <View style={styles.stateHeading}>
            <Text variant="h2">Enter the code</Text>
            <Text variant="bodySmall" color="muted">
              We sent a code to {phone.trim()}. Enter it to confirm your payment.
            </Text>
          </View>
        </View>
        <Input
          label="Verification code"
          placeholder="000000"
          keyboardType="number-pad"
          maxLength={6}
          doneAccessory
          value={otpCode}
          onChangeText={setOtpCode}
          error={otpError ?? undefined}
          editable={!otpExpired}
          style={styles.codeInput}
        />
        {otpExpired ? (
          <Button label="Start over" onPress={handleRestartOtp} />
        ) : (
          <Button label="Confirm payment" onPress={() => void handleConfirmOtp()} loading={confirmingOtp} />
        )}
      </View>
    );
  }

  // ── MOMO path — waiting for push-prompt approval ─────────────────────────────
  if (momoPhase === "waiting") {
    return (
      <View style={styles.section}>
        <View style={styles.stateHeader}>
          <ServiceIcon
            name="time-outline"
            size={48}
            iconSize={22}
            background={colors.primary[50]}
            color={colors.primary[600]}
          />
          <View style={styles.stateHeading}>
            <Text variant="h2">Approve the prompt</Text>
            <Text variant="bodySmall" color="muted">
              Check your phone and approve the MoMo payment request.
            </Text>
          </View>
        </View>
        <LoadingState message="Waiting for confirmation…" />
      </View>
    );
  }

  // ── MOMO path — confirmed ────────────────────────────────────────────────────
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon
          name="checkmark-circle"
          size={48}
          iconSize={22}
          background={colors.successSurface}
          color={colors.success}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">Payment confirmed</Text>
          <Text variant="bodySmall" color="muted">
            {formatGhs(yourFarePesewas)} received — thanks!
          </Text>
        </View>
      </View>
      {savingsPesewas > 0 && <SharedSavingsNote amountPesewas={savingsPesewas} />}
      <Button label="Rate your driver" onPress={() => setRatingReady(true)} />
    </View>
  );
}

function CancelledContent({
  onDone,
  title = "Ride cancelled",
  message = "Your request has been cancelled.",
}: {
  onDone: () => void;
  title?: string;
  message?: string;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon
          name="close-circle"
          size={48}
          iconSize={22}
          background={colors.errorSurface}
          color={colors.error}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">{title}</Text>
          <Text variant="bodySmall" color="muted">
            {message}
          </Text>
        </View>
      </View>
      <Button label="Back to home" variant="secondary" onPress={onDone} />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  sheetBackground: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
  },
  sheetHandle: { backgroundColor: colors.borderStrong, width: 40, height: 5 },
  sheetContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  // ── Options
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
  // ── State panels
  section: { gap: spacing.md },
  stateHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  stateHeading: { flex: 1, gap: 4 },
  progressSection: { gap: spacing.xs },
  progressLabel: { textAlign: "center" },
  savingsNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.successSurface,
    borderWidth: 1,
    borderColor: colors.primary[100],
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  savingsNoteText: { flex: 1, color: colors.success, fontWeight: typography.weight.semibold },
  infoCard: { gap: spacing.sm },
  infoRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  infoLabel: { flex: 1 },
  buttonGroup: { gap: spacing.md },
  // ── Driver card
  driverCard: {},
  driverRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  driverInfo: { flex: 1, gap: 2 },
  ratingRow: { flexDirection: "row", alignItems: "center" },
  plateBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.sm,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
  // ── Rating
  ratingSection: { alignItems: "center", gap: spacing.sm },
  starsRow: { flexDirection: "row", gap: spacing.sm },
  // ── Payment method selector (options screen)
  paymentSection: { gap: spacing.sm },
  paymentRow: { flexDirection: "row", gap: spacing.sm },
  paymentOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  paymentOptionSelected: {
    borderColor: colors.primary[500],
    backgroundColor: colors.primary[50],
  },
  // ── MOMO network pill row (completed screen)
  networkRow: { flexDirection: "row", gap: spacing.sm },
  networkOption: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  networkOptionSelected: {
    borderColor: colors.primary[500],
    backgroundColor: colors.primary[50],
  },
  // ── Error card (MOMO failed state)
  errorCard: {
    backgroundColor: colors.errorSurface,
    borderColor: colors.error,
    borderWidth: 1,
  },
  // ── OTP code entry (MOMO otp state)
  codeInput: {
    fontFamily: typography.fontFamily.mono,
    fontSize: typography.size["2xl"],
    fontWeight: typography.weight.bold,
    textAlign: "center",
    letterSpacing: 8,
  },
});
