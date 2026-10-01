import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import { Ionicons } from "@expo/vector-icons";
import {
  CAR_SEATS,
  DRIVER_CLIENT_EVENTS,
  NO_SHOW_AFTER_MS,
  DRIVER_EVENTS,
  etaToStopMinutes,
  formatCedis,
  formatWait,
  indexRoutes,
  isAtStop,
  noShowAvailableAt,
  planTripStops,
  routeAttribution,
  seatStates,
  splitFare,
  tripPath,
  type LatLng,
  type TripStop,
  type TripZone,
} from "@rida/shared";
import {
  Button,
  Card,
  Illustration,
  LoadingState,
  Screen,
  Text,
  callPhone,
  colors,
  getFillSuggestions,
  getRideSocket,
  openDirections,
  radii,
  shadows,
  spacing,
  typography,
  useAuth,
  useCountUp,
  type PassengerInCar,
  type RideWithZones,
} from "@rida/mobile-shared";
import { driverActiveRideQueryKey, useDriverActiveTrip } from "../../lib/activeTrip";
import { useDriverLocation, useLocationDemand } from "../../lib/location";
import { useZoneRoutes, useZones } from "../../lib/zones";
import {
  clearClaim,
  overlayPassengers,
  runAddRider,
  runPassengerAction,
  setTripActionsRefresh,
  settleWith,
  useTripActions,
} from "../../lib/tripActions";
import { TripMap } from "../../components/trip/TripMap";
import { SlideToConfirm } from "../../components/trip/SlideToConfirm";
import { StopListSheet } from "../../components/trip/StopListSheet";
import { AddRiderSheet } from "../../components/trip/AddRiderSheet";
import { SeatDots } from "../../components/trip/SeatDots";
import { RateRidersPanel } from "../../components/trip/RateRidersPanel";

/** Riders see the driver move: one position every few seconds for the whole trip. */
const LOCATION_SEND_MS = 4_000;
/** The trip screen checks its trip more often than the rest of the app (a rider may cancel). */
const TRIP_POLL_MS = 5_000;

interface DoneSummary {
  rideId: string;
  /** What the riders paid in total (cash to collect, or MoMo). */
  totalPesewas: number;
  driverSharePesewas: number;
  commissionPesewas: number;
  cash: boolean;
}

/** Ticks once a second while `on` — for the pickup wait timer. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * The trip screen — one screen for Ride alone and Shared trips, built around
 * STOPS (design sketches 4, 5, 7, 8):
 *
 * - a full map with the driver, every stop numbered in order, and the route;
 * - the NEXT STOP card with Navigate and Call, and ONE slide action
 *   ("Ama picked up", "Cash collected" with the amount large);
 * - "I'm here" as the fallback for automatic arrival, and "Rider didn't show"
 *   three minutes after arriving;
 * - "N more stops" opens the ordered stop list; seat dots; "Add a rider"
 *   (before the first pickup) opens a compact sheet.
 *
 * Every action is optimistic (lib/tripActions): the screen moves at once,
 * the request follows in the background and is retried quietly; only a real
 * refusal puts it back, with the server's reason.
 */
export default function TripScreen() {
  const { id: rideId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { isAuthenticated, user } = useAuth();
  useKeepAwake();

  const { data: activeRide, isLoading } = useDriverActiveTrip(TRIP_POLL_MS);
  const actions = useTripActions();
  const { data: zoneList = [] } = useZones();
  const { data: storedRoutes = [] } = useZoneRoutes();
  const location = useDriverLocation();
  useLocationDemand("trip", true);

  const ride: RideWithZones | null = activeRide && activeRide.id === rideId ? activeRide : null;
  const claim = actions.claim?.rideId === rideId ? actions.claim : null;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
    void queryClient.invalidateQueries({ queryKey: ["fillSuggestions"] });
  }, [queryClient]);
  useEffect(() => setTripActionsRefresh(refresh), [refresh]);

  // Drop optimistic overlays once the server has caught up.
  useEffect(() => {
    if (ride) settleWith(ride.id, ride.passengers);
  }, [ride]);

  const zones = useMemo(() => new Map<string, TripZone>(zoneList.map((z) => [z.id, z])), [zoneList]);
  const routes = useMemo(() => indexRoutes(storedRoutes), [storedRoutes]);
  const passengers: PassengerInCar[] = useMemo(
    () => (ride ? overlayPassengers(ride.id, ride.passengers) : []),
    // actions changes when an overlay does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ride, actions.seats, actions.adds],
  );
  const position = location.position;
  const plan = useMemo(
    () =>
      planTripStops({
        passengers: passengers
          .filter((p) => p.pickupZoneId && p.dropoffZoneId)
          .map((p) => ({ ...p, pickupZoneId: p.pickupZoneId!, dropoffZoneId: p.dropoffZoneId! })),
        zones,
        from: position,
      }),
    [passengers, zones, position],
  );
  const next: TripStop | undefined = plan.upcoming[0];
  const path = useMemo(
    () => tripPath(position, plan.upcoming.map((s) => s.zone), zoneList, routes),
    [position, plan.upcoming, zoneList, routes],
  );
  const etaMinutes = next ? etaToStopMinutes(position, next.zone, zoneList, routes) : null;
  const atNextStop = next ? isAtStop(position, next.zone) : false;

  // ─── Done: the last drop-off (shown at once, optimistically) ─────────────
  const [done, setDone] = useState<DoneSummary | null>(null);
  const hadStopsRef = useRef(false);
  useEffect(() => {
    if (!ride) return;
    if (plan.upcoming.length > 0) {
      hadStopsRef.current = true;
      if (done?.rideId === ride.id) setDone(null); // a refused drop-off came back
      return;
    }
    if (!hadStopsRef.current || done) return;
    const carried = passengers.filter((p) => p.status === "DROPPED_OFF");
    if (carried.length === 0) return;
    const total = carried.reduce((sum, p) => sum + (p.lockedFare ?? 0), 0);
    const { driverShare, commission } = splitFare(total);
    setDone({
      rideId: ride.id,
      totalPesewas: total,
      driverSharePesewas: driverShare,
      commissionPesewas: commission,
      cash: ride.paymentMethod === "CASH",
    });
  }, [ride, plan.upcoming.length, passengers, done]);

  // ─── Automatic arrival at a pickup ("I'm here" is the fallback) ─────────
  const autoArrivedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!ride || !next || next.kind !== "PICKUP" || next.passengerStatus !== "WAITING") return;
    if (!atNextStop || next.passengerId.startsWith("pending:")) return;
    if (autoArrivedRef.current.has(next.passengerId)) return;
    autoArrivedRef.current.add(next.passengerId);
    runPassengerAction(ride.id, next.passengerId, "arrived");
  }, [ride, next, atNextStop]);

  // ─── Live location to the riders, for the whole trip ─────────────────────
  const positionRef = useRef<LatLng | null>(position);
  positionRef.current = position;
  const liveRideId = ride?.id ?? null;
  useEffect(() => {
    if (!liveRideId) return;
    const socket = getRideSocket();
    const send = () => {
      const p = positionRef.current;
      if (p) socket.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: liveRideId, lat: p.latitude, lng: p.longitude });
    };
    send();
    const t = setInterval(send, LOCATION_SEND_MS);
    return () => clearInterval(t);
  }, [liveRideId]);

  // ─── Adding riders (Shared, before the first pickup) ─────────────────────
  const assembling = Boolean(ride && ride.type === "SHARED" && (ride.status === "MATCHED" || ride.status === "ARRIVED"));
  const activeSeats = passengers.filter((p) => p.status === "WAITING" || p.status === "ARRIVED" || p.status === "PICKED_UP").length;
  const freeSeats = Math.max(0, CAR_SEATS - activeSeats);
  const { data: fill, refetch: refetchFill } = useQuery({
    queryKey: ["fillSuggestions", ride?.id],
    queryFn: () => getFillSuggestions(ride!.id),
    enabled: assembling,
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (!assembling) return;
    const socket = getRideSocket();
    const onBroadcast = () => void refetchFill();
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [assembling, refetchFill]);
  const suggestions = (fill?.suggestions ?? []).filter((s) => !actions.adds[s.requestRideId]);

  // ─── Layout ──────────────────────────────────────────────────────────────
  const [cardHeight, setCardHeight] = useState(300);
  const [topHeight, setTopHeight] = useState(insets.top + 64);
  const [stopsOpen, setStopsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Refusals: the server's reason, in a banner the driver dismisses.
  const [refusal, setRefusal] = useState<string | null>(null);
  const lastRefusalId = useRef(actions.refusal?.id ?? 0);
  useEffect(() => {
    if (actions.refusal && actions.refusal.id !== lastRefusalId.current) {
      lastRefusalId.current = actions.refusal.id;
      setRefusal(actions.refusal.message);
    }
  }, [actions.refusal]);

  const now = useNow(next?.kind === "PICKUP" && next.passengerStatus === "ARRIVED");

  const goHome = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
    if (router.canDismiss()) router.dismissAll();
    else router.replace("/");
  }, [router, queryClient]);

  if (!isAuthenticated || !user) return <Redirect href="/auth/phone" />;

  // ─── Done ────────────────────────────────────────────────────────────────
  if (done && done.rideId === rideId) {
    return (
      <Screen>
        <View style={styles.center}>
          <Illustration name="tripComplete" size={150} pop />
          <Text variant="h1" style={styles.centerText}>
            Trip complete
          </Text>
          <Card dark style={styles.earnCard}>
            <Text variant="label" color="glow">
              {done.cash ? "CASH COLLECTED" : "YOUR EARNINGS (85%)"}
            </Text>
            <CountUpCedis pesewas={done.cash ? done.totalPesewas : done.driverSharePesewas} />
            {done.cash ? (
              <Text variant="bodySmall" style={styles.earnSub}>
                Your share {formatCedis(done.driverSharePesewas)} · platform fee {formatCedis(done.commissionPesewas)}
              </Text>
            ) : null}
          </Card>
          <RateRidersPanel rideId={done.rideId} />
          <Button label="Back to Home" size="lg" onPress={goHome} />
        </View>
      </Screen>
    );
  }

  // ─── Accepting (the claim is still on its way) or refused ──────────────
  if (!ride && claim) {
    const req = claim.request;
    const pickupZone = zones.get(req.pickupZoneId);
    if (claim.state === "refused") {
      return (
        <Screen>
          <View style={styles.center}>
            <Illustration name="searchEmpty" size={140} />
            <Text variant="h2" style={styles.centerText}>
              Not accepted
            </Text>
            <Text variant="bodySmall" color="muted" style={styles.centerText}>
              {claim.message}
            </Text>
            <Button
              label="Back to requests"
              size="lg"
              onPress={() => {
                clearClaim();
                if (router.canGoBack()) router.back();
                else router.replace("/requests");
              }}
            />
          </View>
        </Screen>
      );
    }
    return (
      <View style={styles.root}>
        <TripMap
          driver={position}
          stops={
            pickupZone
              ? [
                  {
                    key: "claim",
                    kind: "PICKUP",
                    passengerId: "claim",
                    riderFirstName: "your rider",
                    riderPhone: null,
                    zone: pickupZone,
                    farePesewas: req.farePesewas,
                    passengerStatus: "WAITING",
                    arrivedAt: null,
                  },
                ]
              : []
          }
          path={pickupZone && position ? [position, pickupZone] : []}
          insets={{ top: topHeight, bottom: cardHeight }}
        />
        <TopBar onBack={goHome} onLayout={(e) => setTopHeight(e.nativeEvent.layout.height)} syncing={actions.retrying}>
          <Chip label="Accepted" />
        </TopBar>
        <View style={[styles.card, { paddingBottom: insets.bottom + spacing.lg }]} onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}>
          <Text variant="label" color="muted">NEXT STOP · PICKUP</Text>
          <Text variant="h2">Pick up at {req.pickupZoneName}</Text>
          <Text variant="bodySmall" color="muted">
            Then {req.dropoffZoneName} · {formatCedis(req.farePesewas)}
          </Text>
          {pickupZone ? (
            <Button
              label="Navigate"
              variant="secondary"
              onPress={() => void openDirections({ ...pickupZone, label: pickupZone.name })}
            />
          ) : null}
          <Text variant="caption" color="muted">Confirming with the rider…</Text>
        </View>
      </View>
    );
  }

  if (!ride) {
    if (isLoading) {
      return (
        <Screen>
          <LoadingState message="Loading your trip…" />
        </Screen>
      );
    }
    return (
      <Screen>
        <View style={styles.center}>
          <Illustration name="searchEmpty" size={140} />
          <Text variant="h2" style={styles.centerText}>
            This trip has ended
          </Text>
          <Text variant="bodySmall" color="muted" style={styles.centerText}>
            The rider cancelled, or the trip was closed. You&apos;re free to take new requests.
          </Text>
          <Button label="Back to Home" onPress={goHome} size="lg" />
        </View>
      </Screen>
    );
  }

  // ─── On the trip ─────────────────────────────────────────────────────────
  const tripFare = passengers
    .filter((p) => p.status !== "CANCELLED")
    .reduce((sum, p) => sum + (p.lockedFare ?? 0), 0);
  const seats = seatStates(passengers);

  return (
    <View style={styles.root}>
      <TripMap
        driver={position}
        stops={plan.upcoming}
        path={path}
        insets={{ top: topHeight, bottom: cardHeight }}
        attribution={storedRoutes.length > 0 ? routeAttribution(storedRoutes[0]!.provider) : null}
      />

      <TopBar onBack={goHome} onLayout={(e) => setTopHeight(e.nativeEvent.layout.height)} syncing={actions.retrying}>
        <Chip label={`${Math.min(plan.doneCount + 1, plan.totalCount)} of ${plan.totalCount}`} />
        {tripFare > 0 ? <Chip label={formatCedis(tripFare)} /> : null}
        {location.isFake && location.fake && next ? (
          <Pressable
            onPress={() =>
              location.fake!.driving
                ? location.fake!.driveAlong(null)
                : location.fake!.driveAlong(position ? tripPath(position, [next.zone], zoneList, routes) : null)
            }
            accessibilityRole="button"
            accessibilityLabel={location.fake.driving ? "Stop the fake drive" : "Fake-drive to the next stop"}
          >
            <Chip label={location.fake.driving ? "■ Stop" : "▶ Drive (fake)"} warn />
          </Pressable>
        ) : null}
      </TopBar>

      <View
        style={[styles.card, { paddingBottom: insets.bottom + spacing.lg }]}
        onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
      >
        {refusal ? (
          <View style={styles.refusal} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle" size={18} color={colors.danger} />
            <Text variant="bodySmall" style={styles.refusalText}>
              {refusal}
            </Text>
            <Pressable onPress={() => setRefusal(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
              <Text variant="bodySmall" style={styles.refusalOk}>OK</Text>
            </Pressable>
          </View>
        ) : null}

        {next ? (
          <NextStopCard
            ride={ride}
            stop={next}
            etaMinutes={etaMinutes}
            atStop={atNextStop}
            now={now}
          />
        ) : (
          <Text variant="bodySmall" color="muted">Finishing up…</Text>
        )}

        <View style={styles.footerRow}>
          {plan.upcoming.length > 1 ? (
            <Pressable
              onPress={() => setStopsOpen(true)}
              style={styles.moreStops}
              accessibilityRole="button"
              accessibilityLabel={`${plan.upcoming.length - 1} more stops. Show all stops.`}
            >
              <Ionicons name="list" size={16} color={colors.ink[700]} />
              <Text variant="bodySmall" style={styles.moreStopsText}>
                {plan.upcoming.length - 1} more stop{plan.upcoming.length - 1 === 1 ? "" : "s"}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
          {ride.type === "SHARED" ? (
            <View style={styles.seatsAndAdd}>
              <SeatDots seats={seats} />
              {assembling && freeSeats > 0 ? (
                <Pressable
                  onPress={() => setAddOpen(true)}
                  style={styles.addChip}
                  accessibilityRole="button"
                  accessibilityLabel={`Add a rider. ${suggestions.length} waiting nearby.`}
                >
                  <Ionicons name="person-add-outline" size={14} color={colors.primary[600]} />
                  <Text variant="caption" style={styles.addChipText}>
                    Add rider{suggestions.length > 0 ? ` (${suggestions.length})` : ""}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      <StopListSheet visible={stopsOpen} onClose={() => setStopsOpen(false)} stops={plan.upcoming} nextEtaMinutes={etaMinutes} />
      <AddRiderSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        suggestions={suggestions}
        freeSeats={freeSeats}
        onAdd={(s) => {
          runAddRider(ride.id, s);
          setAddOpen(false);
        }}
      />
    </View>
  );
}

// ─── Next stop ───────────────────────────────────────────────────────────────

function NextStopCard({
  ride,
  stop,
  etaMinutes,
  atStop,
  now,
}: {
  ride: RideWithZones;
  stop: TripStop;
  etaMinutes: number | null;
  atStop: boolean;
  now: number;
}) {
  const name = stop.riderFirstName;
  const pending = stop.passengerId.startsWith("pending:");
  const where =
    atStop || (stop.kind === "PICKUP" && stop.passengerStatus === "ARRIVED")
      ? "you're here"
      : etaMinutes !== null
        ? `${etaMinutes} min away`
        : null;
  const act = (action: Parameters<typeof runPassengerAction>[2]) => runPassengerAction(ride.id, stop.passengerId, action);

  const arrived = stop.kind === "PICKUP" && stop.passengerStatus === "ARRIVED";
  const arrivedAt = stop.arrivedAt ? Date.parse(stop.arrivedAt) : null;
  const noShowAt = noShowAvailableAt(stop.arrivedAt);
  const canNoShow = noShowAt !== null && now >= noShowAt;
  const cash = ride.paymentMethod === "CASH";

  return (
    <View style={styles.nextStop}>
      <View style={styles.nextHeader}>
        <Text variant="label" color="muted">
          NEXT STOP · {stop.kind === "PICKUP" ? "PICKUP" : "DROP-OFF"}
        </Text>
      </View>
      <Text variant="h2" numberOfLines={1}>
        {stop.kind === "PICKUP" ? "Pick up" : "Drop off"} {name}
      </Text>
      <Text variant="bodySmall" color="muted" numberOfLines={1}>
        {stop.zone.name}
        {where ? ` · ${where}` : ""}
      </Text>

      {arrived && arrivedAt !== null ? (
        <View style={styles.waitRow}>
          <Ionicons name="checkmark-circle" size={18} color={colors.primary[500]} />
          <Text variant="bodySmall" style={styles.waitText}>
            {name} knows you&apos;re here
          </Text>
          <Text variant="bodySmall" color="muted">
            Waiting {formatWait(now - arrivedAt)}
          </Text>
        </View>
      ) : null}

      {stop.kind === "DROPOFF" && stop.farePesewas !== null ? (
        <View style={styles.cashBox} accessible accessibilityLabel={`${cash ? "Collect cash" : "Fare"}: ${formatCedis(stop.farePesewas)}`}>
          <Text variant="bodySmall" style={styles.cashLabel}>
            {cash ? "Collect cash" : "Fare (paid by MoMo)"}
          </Text>
          <Text variant="h1" style={styles.cashAmount}>
            {formatCedis(stop.farePesewas)}
          </Text>
        </View>
      ) : null}

      {/* Navigate + Call. Each takes half the width and may shrink; nothing runs off the edge. */}
      <View style={styles.actionRow}>
        <View style={styles.actionCell}>
          <Button
            label="Navigate"
            variant="secondary"
            onPress={() => void openDirections({ latitude: stop.zone.latitude, longitude: stop.zone.longitude, label: stop.zone.name })}
          />
        </View>
        {stop.riderPhone ? (
          <View style={styles.actionCell}>
            <Button label={`Call ${name}`} variant="secondary" onPress={() => void callPhone(stop.riderPhone, name)} />
          </View>
        ) : null}
      </View>

      {pending ? (
        <Text variant="caption" color="muted">Adding {stop.zone.name} rider to your car…</Text>
      ) : stop.kind === "PICKUP" ? (
        <>
          <SlideToConfirm label={`${name} picked up`} onConfirm={() => {
            if (stop.passengerStatus === "WAITING") act("arrived");
            act("pickup");
          }} />
          <View style={styles.smallLinks}>
            {stop.passengerStatus === "WAITING" ? (
              <>
                <SmallLink label="I'm here" onPress={() => act("arrived")} hint="Tell the rider you've arrived" />
                <SmallLink
                  label="Cancel pickup"
                  danger
                  onPress={() =>
                    Alert.alert(`Remove ${name}?`, "They'll be told their pickup was cancelled.", [
                      { text: "Keep", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => act("cancel") },
                    ])
                  }
                />
              </>
            ) : (
              <SmallLink
                label={canNoShow || noShowAt === null ? "Rider didn't show" : `Rider didn't show (at ${formatWait(NO_SHOW_AFTER_MS)})`}
                danger
                disabled={!canNoShow}
                onPress={() =>
                  Alert.alert(`${name} didn't show?`, "Their pickup is cancelled and they're told why.", [
                    { text: "Keep waiting", style: "cancel" },
                    { text: "Cancel pickup", style: "destructive", onPress: () => act("no-show") },
                  ])
                }
              />
            )}
          </View>
        </>
      ) : (
        <SlideToConfirm label={cash ? "Cash collected" : `${name} dropped off`} tone="dark" onConfirm={() => act("dropoff")} />
      )}
    </View>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function TopBar({
  onBack,
  onLayout,
  syncing,
  children,
}: {
  onBack: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
  syncing: boolean;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]} onLayout={onLayout} pointerEvents="box-none">
      {/* Minimise: the trip carries on; the banner on every tab brings the driver back. */}
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go to Home. Your trip continues." hitSlop={6} style={styles.roundButton}>
        <Ionicons name="arrow-back" size={22} color={colors.ink[900]} />
      </Pressable>
      <View style={styles.chips}>{children}</View>
      {syncing ? (
        <View style={styles.syncing} accessibilityLiveRegion="polite" accessibilityLabel="Sending. Waiting for a connection.">
          <Ionicons name="cloud-upload-outline" size={16} color={colors.ink[600]} />
          <Text variant="caption" color="muted">Sending…</Text>
        </View>
      ) : null}
    </View>
  );
}

function Chip({ label, warn }: { label: string; warn?: boolean }) {
  return (
    <View style={[styles.chip, warn && styles.chipWarn]}>
      <Text variant="caption" style={[styles.chipText, warn && styles.chipWarnText]}>
        {label}
      </Text>
    </View>
  );
}

function SmallLink({
  label,
  onPress,
  danger,
  disabled,
  hint,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={styles.smallLink}
    >
      <Text
        variant="bodySmall"
        style={[styles.smallLinkText, danger && styles.smallLinkDanger, disabled && styles.smallLinkDisabled]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function CountUpCedis({ pesewas }: { pesewas: number }) {
  const shown = useCountUp(pesewas);
  return (
    <Text variant="h1" color="inverse" style={styles.earnAmount}>
      {formatCedis(shown)}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, paddingHorizontal: spacing.xl },
  centerText: { textAlign: "center" },
  earnCard: { alignItems: "center", paddingVertical: spacing.xl, gap: spacing.sm, width: "100%" },
  earnAmount: { fontWeight: typography.weight.extrabold },
  earnSub: { color: "rgba(255,255,255,0.7)", textAlign: "center" },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.md,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, flexShrink: 1 },
  chip: {
    backgroundColor: colors.white,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    ...shadows.sm,
  },
  chipText: { fontWeight: typography.weight.bold, color: colors.ink[900] },
  chipWarn: { backgroundColor: colors.warningSurface },
  chipWarnText: { color: colors.warning },
  syncing: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.white,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  card: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    gap: spacing.md,
    ...shadows.lg,
  },
  refusal: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.errorSurface,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  refusalText: { flex: 1, color: colors.danger },
  refusalOk: { color: colors.danger, fontWeight: typography.weight.bold },
  nextStop: { gap: spacing.sm },
  nextHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  waitRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" },
  waitText: { fontWeight: typography.weight.semibold, color: colors.primary[600], flexShrink: 1 },
  cashBox: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  cashLabel: { color: colors.ink[600], fontWeight: typography.weight.semibold },
  cashAmount: { fontWeight: typography.weight.extrabold, fontSize: 40, lineHeight: 46 },
  actionRow: { flexDirection: "row", gap: spacing.sm },
  actionCell: { flex: 1, minWidth: 0 },
  smallLinks: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.sm },
  smallLink: { paddingVertical: spacing.xs, minHeight: 32, justifyContent: "center" },
  smallLinkText: { color: colors.ink[700], fontWeight: typography.weight.semibold },
  smallLinkDanger: { color: colors.danger },
  smallLinkDisabled: { color: colors.ink[300] },
  footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  moreStops: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs, minHeight: 36 },
  moreStopsText: { fontWeight: typography.weight.semibold, color: colors.ink[700] },
  seatsAndAdd: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  addChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.primary[200],
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    minHeight: 32,
  },
  addChipText: { color: colors.primary[600], fontWeight: typography.weight.bold },
});
