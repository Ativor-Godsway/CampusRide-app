import { useEffect, useRef, type ReactNode } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spokenCedis, type LatLng } from "@rida/shared";
import {
  CampusMapView,
  Card,
  Notice,
  Text,
  colors,
  formatCedis,
  radii,
  sizes,
  spacing,
  useReduceMotion,
  type CampusMapZone,
} from "@rida/mobile-shared";
import { tapFeedback } from "../../lib/offerAlert";
import { CountdownRing } from "./CountdownRing";

/** The map's share of the screen, above the panel. */
const MAP_SHARE = 0.36;
/** The panel's top corners overlap the map by this much. */
const PANEL_OVERLAP = radii.xl;

export interface TakeoverCountdown {
  /** Epoch ms when it runs out. */
  deadline: number;
  /** The whole countdown, for how full it starts. */
  totalMs: number;
  /** Epoch ms to stop at (Accept tapped), or undefined while it runs. */
  frozenAt?: number;
}

export interface RequestTakeoverProps {
  /** For VoiceOver / TalkBack: what this is, in one sentence. */
  accessibilityLabel: string;
  /** The map: the car, a dashed line to the pickup, the route to the drop-off. */
  car: LatLng | null;
  pickup: (LatLng & { label: string }) | null;
  dropoff: (LatLng & { label: string }) | null;
  /** The green route (falls back to a dashed straight line between the stops). */
  route?: LatLng[];
  routeIsRoad?: boolean;
  /** The ring and the Accept fill; null for a request with no time limit. */
  countdown: TakeoverCountdown | null;
  /** "NEW RIDE REQUEST", "ADD A RIDER". */
  eyebrow: string;
  /** Under the eyebrow: ride type, rating, detour. */
  chips: ReactNode;
  farePesewas: number;
  earnPesewas: number;
  from: string;
  to: string;
  /** "Pickup · 1 min · 400 m away". */
  pickupLine: string;
  /** "Drop-off · 5 min trip · 1.6 km". */
  dropoffLine: string;
  /** Under the stops, small: "+3 more waiting". */
  footnote?: string | null;
  accepting: boolean;
  error: string | null;
  /** "Accept"; "Try again" is shown after an error. */
  acceptLabel: string;
  /** Not ready yet (e.g. the route is still being checked). */
  acceptDisabled?: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * A request, full screen over everything (docs/mockups/10-driver-ride-offer.png):
 * the map on top — the car, a dashed ink line to the pickup, the green route
 * to the drop-off — and a white panel with the countdown, the price and what
 * the driver earns, the stops, and ONE big Accept whose darker fill runs down
 * with the countdown, then Decline. Used for new ride offers (OfferTakeover)
 * and for adding a rider to a shared trip (AddRiderTakeover).
 */
export function RequestTakeover(p: RequestTakeoverProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduceMotion = useReduceMotion();

  const mapZones: CampusMapZone[] = [
    ...(p.car ? [{ id: "car", ...p.car, label: "You", role: "driver" as const }] : []),
    ...(p.pickup ? [{ id: "pickup", ...p.pickup, role: "pickup" as const }] : []),
    ...(p.dropoff ? [{ id: "dropoff", ...p.dropoff, role: "dropoff" as const }] : []),
  ];
  const ends = p.pickup && p.dropoff ? [p.pickup, p.dropoff] : null;
  const fitTo: LatLng[] = [...(p.car ? [p.car] : []), ...(ends ?? [])];
  const mapHeight = Math.round(height * MAP_SHARE) + PANEL_OVERLAP;
  const label = p.error ? "Try again" : p.acceptLabel;

  const accept = () => {
    tapFeedback();
    p.onAccept();
  };

  return (
    <Modal
      visible
      animationType={reduceMotion ? "none" : "slide"}
      presentationStyle="fullScreen"
      statusBarTranslucent
      // Android back: the same as Decline (not while the accept is on its way).
      onRequestClose={() => !p.accepting && p.onDecline()}
    >
      <View style={styles.screen}>
        {fitTo.length > 0 ? (
          <CampusMapView
            initialRegion={{ ...fitTo[0]!, latitudeDelta: 0.012, longitudeDelta: 0.012 }}
            zones={mapZones}
            approachLine={p.car && p.pickup ? [p.car, p.pickup] : undefined}
            routeLine={p.route ?? ends ?? undefined}
            routeIsRoad={Boolean(p.route) && Boolean(p.routeIsRoad)}
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
          accessibilityLabel={p.accessibilityLabel}
        >
          {/* The details scroll on a small phone; Accept and Decline stay put. */}
          <ScrollView style={styles.details} contentContainerStyle={styles.detailsContent}>
            <View style={styles.header}>
              {p.countdown ? (
                <CountdownRing
                  deadline={p.countdown.deadline}
                  totalMs={p.countdown.totalMs}
                  frozenAt={p.countdown.frozenAt}
                />
              ) : null}
              <View style={styles.headerText}>
                <Text variant="eyebrow" color="secondary">
                  {p.eyebrow}
                </Text>
                <View style={styles.chips}>{p.chips}</View>
              </View>
            </View>

            <View style={styles.priceRow}>
              <Text style={styles.price} tabular accessibilityLabel={spokenCedis(p.farePesewas)}>
                {formatCedis(p.farePesewas)}
              </Text>
              <Text variant="body" color="secondary" style={styles.earn}>
                You earn{" "}
                <Text variant="bodyStrong" tabular style={styles.earnAmount}>
                  {formatCedis(p.earnPesewas)}
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
                  <Text variant="title3">{p.from}</Text>
                  <Text variant="subhead" color="secondary">
                    {p.pickupLine}
                  </Text>
                </View>
              </View>
              <View style={styles.stop}>
                <View style={styles.markerColumn}>
                  <View style={styles.dropoffSquare} />
                </View>
                <View style={styles.stopText}>
                  <Text variant="title3">{p.to}</Text>
                  <Text variant="subhead" color="secondary">
                    {p.dropoffLine}
                  </Text>
                </View>
              </View>
            </Card>

            {p.footnote ? (
              <Text variant="caption" color="secondary">
                {p.footnote}
              </Text>
            ) : null}

            {p.error ? (
              <Notice tone="error" icon="cloud-offline-outline" message={p.error} />
            ) : null}
          </ScrollView>

          <AcceptPill
            countdown={p.countdown}
            loading={p.accepting}
            disabled={Boolean(p.acceptDisabled)}
            label={label}
            onPress={accept}
            accessibilityLabel={`${label}, ${spokenCedis(p.farePesewas)}`}
          />
          {/* A quiet text button (mockup 10): Accept is the one action. */}
          <Pressable
            onPress={() => {
              tapFeedback();
              p.onDecline();
            }}
            disabled={p.accepting}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Decline this offer"
            accessibilityState={{ disabled: p.accepting }}
            style={({ pressed }) => [styles.decline, pressed && styles.declinePressed]}
          >
            <Text variant="bodyStrong" color={p.accepting ? "tertiary" : "secondary"}>
              Decline
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The 64px green Accept pill. With a countdown, its darker green-600 fill is
 * the time left: full at the start, gone at the deadline (linear, like the
 * ring — it's a clock, so it runs with Reduce Motion on too). The label sits
 * on top; a spinner while the accept is on its way.
 */
function AcceptPill({
  countdown,
  loading,
  disabled,
  label,
  onPress,
  accessibilityLabel,
}: {
  countdown: TakeoverCountdown | null;
  loading: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const left = useRef(new Animated.Value(1)).current;
  const deadline = countdown?.deadline;
  const totalMs = countdown?.totalMs;
  const frozenAt = countdown?.frozenAt;

  useEffect(() => {
    if (deadline === undefined || totalMs === undefined) {
      left.setValue(0);
      return;
    }
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

  const off = disabled && !loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={loading || disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: loading, disabled: loading || disabled }}
      style={({ pressed }) => [
        styles.accept,
        off && styles.acceptOff,
        pressed && styles.acceptPressed,
      ]}
    >
      {off ? null : (
        <Animated.View
          style={[
            styles.acceptFill,
            { width: left.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) },
          ]}
        />
      )}
      {loading ? (
        <ActivityIndicator color={colors.onBrand} />
      ) : (
        <Text variant="button" style={[styles.acceptLabel, off && styles.acceptLabelOff]}>
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
  acceptOff: { backgroundColor: colors.surface3 },
  acceptPressed: { opacity: 0.9 },
  acceptFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.green600,
  },
  acceptLabel: { color: colors.onBrand, fontSize: 20 },
  acceptLabelOff: { color: colors.ink3 },
  decline: {
    alignSelf: "center",
    minHeight: sizes.controlMd,
    justifyContent: "center",
    paddingHorizontal: spacing[6],
    borderRadius: radii.full,
  },
  declinePressed: { backgroundColor: colors.surface2 },
});
