import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  FINISHING_TRIPS_AFTER_MS,
  SEARCH_STEP_DONE_MS,
  SEARCH_TIP_MS,
  searchLiveNote,
  searchSteps,
  searchTips,
  type RideSearchStatus,
  type RideType,
  type SearchStepView,
} from "@rida/shared";
import { Button, Text, colors, serverNow, spacing, useReduceMotion } from "@rida/mobile-shared";

/** When the screen next changes by itself (a step's tick, the "finishing trips" line). */
const BOUNDARIES_MS = [SEARCH_STEP_DONE_MS.send, SEARCH_STEP_DONE_MS.offer, SEARCH_STEP_DONE_MS.check, FINISHING_TRIPS_AFTER_MS];

/** The ms timestamp of a server time, or null. */
function timeOf(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * How far into the search we are, by the server's clock: from the later of
 * the two starts the server gave (the ride's broadcastStartedAt and the
 * status's own, which is the newer after "Search again"), else from when
 * this screen opened. Re-renders only when a step boundary passes — there is
 * no ticking clock on this screen.
 */
export function useSearchElapsed(...starts: Array<Date | string | null | undefined>): number {
  const [openedAt] = useState(() => serverNow());
  const known = starts.map(timeOf).filter((t): t is number => t !== null);
  const start = known.length > 0 ? Math.max(...known) : openedAt;
  const [, setTick] = useState(0);
  const elapsed = Math.max(0, serverNow() - start);
  useEffect(() => {
    const next = BOUNDARIES_MS.find((b) => b > elapsed);
    if (next === undefined) return;
    const timer = setTimeout(() => setTick((n) => n + 1), next - elapsed + 20);
    return () => clearTimeout(timer);
  }, [elapsed, start]);
  return elapsed;
}

/**
 * "Finding your driver": what the search is really doing, as a checklist
 * (@rida/shared rides/searchStatus), over the map where the pickup pulses
 * and the cars nearby show. No timer or countdown anywhere: the steps are
 * timed for reading only. The request reached drivers the moment it was
 * made, and the ride screen swaps this panel for "Driver found" the moment
 * a driver accepts, at any step — nothing here holds it back.
 *
 * Every number comes from the server's status; until it arrives, or when it
 * can't say, the wording has none. Each row keeps one height whichever of
 * its wordings shows, and the live line and tip keep their room, so the
 * sheet never jumps as the steps change.
 */
export function SearchingPanel({
  pickupPlaceName,
  rideType,
  priceLabel,
  broadcastStartedAt,
  status,
  onCancel,
}: {
  /** A real place name for the sentence (pickupPlace), or null: "near you". */
  pickupPlaceName: string | null;
  rideType: RideType;
  priceLabel: string;
  /** From the server; undefined until the ride is first fetched. */
  broadcastStartedAt: Date | string | null | undefined;
  /** The search status (useRideSearchStatus), or null until it arrives. */
  status: RideSearchStatus | null;
  onCancel: () => void;
}) {
  const elapsed = useSearchElapsed(broadcastStartedAt, status?.searchStartedAt);
  const steps = searchSteps(elapsed, status, pickupPlaceName);
  const note = searchLiveNote(elapsed, status);
  const tips = searchTips(status);

  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <Text variant="title2" accessibilityRole="header">
          Finding your driver
        </Text>
        <Text
          variant="subhead"
          color="secondary"
          tabular
          accessibilityLabel={`${rideType === "SHARED" ? "Shared" : "Ride alone"}, ${priceLabel}, paid in cash`}
        >
          {rideType === "SHARED" ? "Shared" : "Ride alone"} · {priceLabel} · Cash
        </Text>
      </View>

      <View style={styles.steps} accessibilityRole="list" accessibilityLiveRegion="polite">
        {steps.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </View>

      <FadeText
        text={note}
        icon={note?.startsWith("A car") ? "car-outline" : "time-outline"}
        style={styles.slot}
        testID="search-live-note"
      />

      <RotatingTips tips={tips} />

      <Button label="Cancel" variant="danger" onPress={onCancel} />
    </View>
  );
}

// ── One step ────────────────────────────────────────────────────────────────

const STATE_WORDS = { pending: "not started", active: "in progress", done: "done" } as const;

function StepRow({ step }: { step: SearchStepView }) {
  // The longest wording, invisible, holds the row's height; the one showing sits on top.
  const longest = useMemo(
    () => step.labels.reduce((a, b) => (b.length > a.length ? b : a), step.label),
    [step.labels, step.label],
  );
  const color = step.state === "pending" ? "tertiary" : "default";
  return (
    <View
      style={styles.step}
      accessible
      accessibilityLabel={`${step.label}${step.detail && step.state !== "pending" ? `. ${step.detail}` : ""}, ${STATE_WORDS[step.state]}`}
      testID={`search-step-${step.key}`}
    >
      <StepMark state={step.state} waiting={step.key === "accept"} />
      <View style={styles.stepText}>
        <View>
          <Text variant="bodyStrong" style={styles.hidden} importantForAccessibility="no-hide-descendants">
            {longest}
          </Text>
          <Text variant="bodyStrong" color={color} style={styles.overlay} testID={`search-step-${step.key}-label`}>
            {step.label}
          </Text>
        </View>
        {step.detail ? (
          <Text
            variant="subhead"
            color="secondary"
            style={step.state === "pending" ? styles.hidden : undefined}
            testID={`search-step-${step.key}-detail`}
          >
            {step.detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Spinner while active, a tick that pops in once done, a soft pulse for the wait. */
function StepMark({ state, waiting }: { state: SearchStepView["state"]; waiting: boolean }) {
  const reduceMotion = useReduceMotion();
  const pop = useRef(new Animated.Value(state === "done" ? 1 : 0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const wasDone = useRef(state === "done");

  useEffect(() => {
    if (state !== "done" || wasDone.current) return;
    wasDone.current = true;
    const anim = reduceMotion
      ? Animated.timing(pop, { toValue: 1, duration: 200, useNativeDriver: true })
      : Animated.spring(pop, { toValue: 1, damping: 14, stiffness: 220, mass: 1, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [state, pop, reduceMotion]);

  const breathing = waiting && state === "active" && !reduceMotion;
  useEffect(() => {
    if (!breathing) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathing, pulse]);

  if (state === "done") {
    const scale = reduceMotion ? 1 : pop.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
    return (
      <View style={styles.mark}>
        <Animated.View style={[styles.done, { opacity: pop, transform: [{ scale }] }]} testID="search-step-done">
          <Ionicons name="checkmark" size={15} color={colors.white} />
        </Animated.View>
      </View>
    );
  }
  if (state === "active" && waiting) {
    return (
      <View style={styles.mark}>
        <Animated.View style={[styles.waitDot, { opacity: pulse }]} />
      </View>
    );
  }
  if (state === "active") {
    return (
      <View style={styles.mark}>
        {reduceMotion ? (
          <View style={styles.stillRing} testID="search-step-still" />
        ) : (
          <ActivityIndicator size="small" color={colors.green500} testID="search-step-spinner" />
        )}
      </View>
    );
  }
  return (
    <View style={styles.mark}>
      <View style={styles.pending} />
    </View>
  );
}

// ── Live line and tips ──────────────────────────────────────────────────────

/** A line that fades from one text to the next (opacity only, also with Reduce Motion). */
function FadeText({
  text,
  icon,
  style,
  testID,
}: {
  text: string | null;
  icon: keyof typeof Ionicons.glyphMap;
  style?: object;
  testID?: string;
}) {
  const [shown, setShown] = useState(text);
  const [shownIcon, setShownIcon] = useState(icon);
  const opacity = useRef(new Animated.Value(text ? 1 : 0)).current;

  useEffect(() => {
    if (text === shown) return;
    if (!shown) {
      // Nothing showing: no fade out to wait for.
      setShown(text);
      setShownIcon(icon);
      // Not stopped by this effect's cleanup: setShown re-runs it at once.
      opacity.setValue(0);
      Animated.timing(opacity, { toValue: 1, duration: 260, useNativeDriver: true }).start();
      return;
    }
    const out = Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true });
    out.start(({ finished }) => {
      if (!finished) return;
      setShown(text);
      setShownIcon(icon);
      if (text) Animated.timing(opacity, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    });
    return () => out.stop();
  }, [text, icon, shown, opacity]);

  return (
    <View style={style} accessibilityLiveRegion="polite">
      {shown ? (
        <Animated.View style={[styles.line, { opacity }]} accessible accessibilityLabel={shown} testID={testID}>
          <Ionicons name={shownIcon} size={16} color={colors.green600} />
          <Text variant="subhead" color="secondary" style={styles.lineText}>
            {shown}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** One tip at a time, fading to the next every SEARCH_TIP_MS. */
function RotatingTips({ tips }: { tips: readonly string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (tips.length < 2) return;
    const timer = setInterval(() => setIndex((i) => i + 1), SEARCH_TIP_MS);
    return () => clearInterval(timer);
  }, [tips.length]);
  const tip = tips.length ? tips[index % tips.length]! : null;
  return <FadeText text={tip} icon="bulb-outline" style={styles.slot} testID="search-tip" />;
}

const MARK = 24;

const styles = StyleSheet.create({
  section: { gap: spacing[4] },
  heading: { gap: spacing[1] },
  steps: { gap: spacing[3] },
  step: { flexDirection: "row", alignItems: "flex-start", gap: spacing[3] },
  stepText: { flex: 1, gap: 2 },
  hidden: { opacity: 0 },
  overlay: { position: "absolute", top: 0, left: 0, right: 0 },
  mark: { width: MARK, height: 22, alignItems: "center", justifyContent: "center" },
  done: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.green500,
    alignItems: "center",
    justifyContent: "center",
  },
  waitDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.green500 },
  stillRing: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.green500 },
  pending: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: colors.ink4 },
  // Room for two lines, kept whether or not anything shows in it.
  slot: { minHeight: 40, justifyContent: "center" },
  line: { flexDirection: "row", alignItems: "flex-start", gap: spacing[2] },
  lineText: { flex: 1 },
});
