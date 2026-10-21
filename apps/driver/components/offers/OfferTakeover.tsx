import { useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  decodePolyline,
  offerKindLabel,
  offerStopLines,
  pointsKey,
  splitFare,
  spokenCedis,
  type LatLng,
  type Zone,
} from "@rida/shared";
import {
  CampusMapView,
  Card,
  Notice,
  StatusChip,
  Text,
  colors,
  formatCedis,
  getRoadRoute,
  radii,
  sizes,
  spacing,
  useReduceMotion,
} from "@rida/mobile-shared";
import type { ShownOffer } from "../../lib/offers";
import { tapFeedback } from "../../lib/offerAlert";
import { CountdownRing } from "./CountdownRing";

/** The map's share of the screen, above the panel. */
const MAP_SHARE = 0.36;
/** The panel's top corners overlap the map by this much. */
const PANEL_OVERLAP = radii.xl;

/**
 * A new ride request, full screen over everything (docs/mockups/
 * 10-driver-ride-offer.png): the map on top — the car, a dashed ink line to
 * the pickup, the green route to the drop-off — and a white panel with the
 * countdown, the price, the stops, and ONE big Accept whose darker fill runs
 * down with the countdown.
 *
 * Places are drawn at their campus zones: the server sends names and
 * numbers only before Accept, never a pickup's exact pin or the rider's note.
 */
export function OfferTakeover({
  offer,
  waiting,
  car,
  zones,
  accepting,
  error,
  onAccept,
  onDecline,
}: {
  offer: ShownOffer;
  /** How many more requests are lined up behind this one. */
  waiting: number;
  /** Where the driver is, or null. */
  car: LatLng | null;
  zones: readonly Zone[];
  /** Accept tapped, waiting for the server. */
  accepting: boolean;
  /** Accept got no answer, or a refusal: said in the panel, with Try again. */
  error: string | null;
  /** Accept, and Try again. */
  onAccept: () => void;
  onDecline: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const { item } = offer;

  const seats = item.seats ?? 1;
  const from = item.pickupPlaceName ?? item.pickupZoneName;
  const to = item.dropoffPlaceName ?? item.dropoffZoneName;
  const lines = offerStopLines(item);
  const earn = item.driverSharePesewas ?? splitFare(item.farePesewas).driverShare;
  const totalMs = offer.deadline - offer.shownAt;

  // ── The map ─────────────────────────────────────────────────────────────
  const pickup = zones.find((z) => z.id === item.pickupZoneId);
  const dropoff = zones.find((z) => z.id === item.dropoffZoneId);
  const ends = useMemo(
    () =>
      pickup && dropoff
        ? [
            { latitude: pickup.latitude, longitude: pickup.longitude },
            { latitude: dropoff.latitude, longitude: dropoff.longitude },
          ]
        : null,
    [pickup, dropoff],
  );
  // The road between the two (POST /routes/legs, cached); a dashed straight
  // line until it answers or if it can't.
  const { data: road } = useQuery({
    queryKey: ["roadRoute", ends ? pointsKey(ends) : "none"],
    queryFn: () => getRoadRoute(ends!),
    enabled: Boolean(ends),
    staleTime: Infinity,
    retry: 1,
  });
  const routeLine = road ? decodePolyline(road.polyline) : (ends ?? undefined);
  const mapZones = [
    ...(car ? [{ id: "car", ...car, label: "You", role: "driver" as const }] : []),
    ...(pickup ? [{ id: "pickup", ...ends![0]!, label: from, role: "pickup" as const }] : []),
    ...(dropoff ? [{ id: "dropoff", ...ends![1]!, label: to, role: "dropoff" as const }] : []),
  ];
  const fitTo = [...(car ? [car] : []), ...(ends ?? [])];
  const mapHeight = Math.round(height * MAP_SHARE) + PANEL_OVERLAP;

  const accept = () => {
    tapFeedback();
    onAccept();
  };

  return (
    <Modal
      visible
      animationType={reduceMotion ? "none" : "slide"}
      presentationStyle="fullScreen"
      statusBarTranslucent
      // Android back: the same as Decline (not while the accept is on its way).
      onRequestClose={() => !accepting && onDecline()}
    >
      <View style={styles.screen}>
        {fitTo.length > 0 ? (
          <CampusMapView
            initialRegion={{
              ...fitTo[0]!,
              latitudeDelta: 0.012,
              longitudeDelta: 0.012,
            }}
            zones={mapZones}
            approachLine={car && ends ? [car, ends[0]!] : undefined}
            routeLine={routeLine}
            routeIsRoad={road?.source === "osrm"}
            height={mapHeight}
            light
            rounded={false}
            fitTo={fitTo}
            fitPadding={{
              top: insets.top + spacing[8],
              bottom: PANEL_OVERLAP + spacing[8],
              left: spacing[10],
              right: spacing[10],
            }}
          />
        ) : (
          <View style={[styles.noMap, { height: mapHeight }]} />
        )}

        <View
          style={[styles.panel, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]}
          accessibilityViewIsModal
          accessibilityLiveRegion="assertive"
          accessibilityLabel={`New ride request. ${offerKindLabel(item.type, seats)}, ${spokenCedis(item.farePesewas)}. From ${from} to ${to}.`}
        >
          {/* The details scroll on a small phone; Accept and Decline stay put. */}
          <ScrollView style={styles.details} contentContainerStyle={styles.detailsContent}>
            <View style={styles.header}>
              <CountdownRing deadline={offer.deadline} totalMs={totalMs} frozenAt={offer.heldAt} />
              <View style={styles.headerText}>
                <Text variant="eyebrow" color="secondary">
                  New ride request
                </Text>
                <View style={styles.chips}>
                  <StatusChip
                    tone="neutral"
                    icon={item.type === "SHARED" ? "people-outline" : "person-outline"}
                    label={offerKindLabel(item.type, seats)}
                  />
                  {item.riderRating != null ? (
                    <StatusChip
                      tone="neutral"
                      icon="star"
                      label={item.riderRating.toFixed(1)}
                      accessibilityLabel={`Rider rated ${item.riderRating.toFixed(1)}`}
                    />
                  ) : (
                    <StatusChip tone="warn" label="New rider" />
                  )}
                </View>
              </View>
            </View>

            <View style={styles.priceRow}>
              <Text style={styles.price} tabular accessibilityLabel={spokenCedis(item.farePesewas)}>
                {formatCedis(item.farePesewas)}
              </Text>
              <Text variant="body" color="secondary" style={styles.earn}>
                You earn{" "}
                <Text variant="bodyStrong" tabular style={styles.earnAmount}>
                  {formatCedis(earn)}
                </Text>
              </Text>
            </View>

            <Card variant="filled" style={styles.stops}>
              <View style={styles.stop}>
                <View style={styles.markerColumn}>
                  <View style={styles.pickupDot} />
                  <View style={styles.connector} />
                </View>
                <View style={styles.stopText}>
                  <Text variant="title3">{from}</Text>
                  <Text variant="subhead" color="secondary">
                    {lines.pickup}
                  </Text>
                </View>
              </View>
              <View style={styles.stop}>
                <View style={styles.markerColumn}>
                  <View style={styles.dropoffSquare} />
                </View>
                <View style={styles.stopText}>
                  <Text variant="title3">{to}</Text>
                  <Text variant="subhead" color="secondary">
                    {lines.dropoff}
                  </Text>
                </View>
              </View>
            </Card>

            {waiting > 0 ? (
              <Text variant="caption" color="secondary">
                +{waiting} more waiting
              </Text>
            ) : null}

            {error ? <Notice tone="error" icon="cloud-offline-outline" message={error} /> : null}
          </ScrollView>

          <AcceptPill
            deadline={offer.deadline}
            totalMs={totalMs}
            frozenAt={offer.heldAt}
            loading={accepting}
            label={error ? "Try again" : "Accept"}
            onPress={accept}
            accessibilityLabel={`${error ? "Try again" : "Accept"}, ${spokenCedis(item.farePesewas)}`}
          />
          {/* A quiet text button (mockup 10): Accept is the one action. */}
          <Pressable
            onPress={() => {
              tapFeedback();
              onDecline();
            }}
            disabled={accepting}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Decline this offer"
            accessibilityState={{ disabled: accepting }}
            style={({ pressed }) => [styles.decline, pressed && styles.declinePressed]}
          >
            <Text variant="bodyStrong" color={accepting ? "tertiary" : "secondary"}>
              Decline
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The 64px green Accept pill. Its darker green-600 fill is the time left:
 * full at the start, gone at the deadline (linear, like the ring — it's a
 * clock, so it runs with Reduce Motion on too). The label sits on top; a
 * spinner while the accept is on its way.
 */
function AcceptPill({
  deadline,
  totalMs,
  frozenAt,
  loading,
  label,
  onPress,
  accessibilityLabel,
}: {
  deadline: number;
  totalMs: number;
  frozenAt?: number;
  loading: boolean;
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const left = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const at = frozenAt ?? Date.now();
    const remaining = Math.max(0, deadline - at);
    left.setValue(remaining / Math.max(1, totalMs));
    if (frozenAt !== undefined) return;
    const anim = Animated.timing(left, {
      toValue: 0,
      duration: remaining,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [deadline, totalMs, frozenAt, left]);

  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: loading, disabled: loading }}
      style={({ pressed }) => [styles.accept, pressed && styles.acceptPressed]}
    >
      <Animated.View
        style={[
          styles.acceptFill,
          { width: left.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) },
        ]}
      />
      {loading ? (
        <ActivityIndicator color={colors.onBrand} />
      ) : (
        <Text variant="button" style={styles.acceptLabel}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  noMap: { backgroundColor: colors.mapLand },
  panel: {
    flex: 1,
    marginTop: -PANEL_OVERLAP,
    gap: spacing[3],
    paddingTop: spacing[5],
    paddingHorizontal: spacing.gutter,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
  },
  details: { flex: 1 },
  detailsContent: { gap: spacing[4], paddingBottom: spacing[2] },
  header: { flexDirection: "row", alignItems: "center", gap: spacing[4] },
  headerText: { flex: 1, gap: spacing[2] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  priceRow: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  // The hero number, bigger than `display` on purpose: the one thing to read at a glance.
  price: { fontSize: 48, lineHeight: 52, fontWeight: "800", letterSpacing: -1, color: colors.ink },
  earn: { flex: 1, textAlign: "right" },
  earnAmount: { color: colors.green700 },
  stops: { gap: spacing[3] },
  stop: { flexDirection: "row", gap: spacing[3] },
  markerColumn: { width: 12, alignItems: "center", paddingTop: 7 },
  pickupDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.green500 },
  // From under the pickup dot down to the drop-off square, through the gap.
  connector: {
    flex: 1,
    width: 2,
    marginTop: 4,
    marginBottom: -spacing[3] - 7,
    backgroundColor: colors.ink4,
  },
  dropoffSquare: { width: 12, height: 12, borderRadius: 3, backgroundColor: colors.ink },
  stopText: { flex: 1, gap: 2 },
  accept: {
    height: sizes.controlGo,
    borderRadius: radii.full,
    backgroundColor: colors.green500,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  acceptPressed: { opacity: 0.9 },
  acceptFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.green600,
  },
  acceptLabel: { color: colors.onBrand, fontSize: 20 },
  decline: {
    alignSelf: "center",
    minHeight: sizes.controlMd,
    justifyContent: "center",
    paddingHorizontal: spacing[6],
    borderRadius: radii.full,
  },
  declinePressed: { backgroundColor: colors.surface2 },
});
