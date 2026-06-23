import type { ReactNode } from "react";
import { View, StyleSheet, type ViewProps } from "react-native";
import { colors, radii, spacing } from "../tokens";

export type RouteStopsTheme = "light" | "dark";

export interface RouteStopsProps extends ViewProps {
  /** Pickup label content — usually a small `<Text>` stack (label + zone name). */
  origin: ReactNode;
  /** Dropoff label content — same shape as `origin`. */
  destination: ReactNode;
  /** "light" (default) for white/light surfaces; "dark" for use on `Card dark` / dark screens. */
  theme?: RouteStopsTheme;
  connectorHeight?: number;
}

/**
 * Presentational origin → destination graphic — filled forest dot with a
 * mint ring, a thin vertical connector, and an ink rounded-square
 * destination marker. Pure layout over caller-supplied label content; binds
 * to whatever pickup/dropoff data the screen already has, no new state.
 */
export function RouteStops({
  origin,
  destination,
  theme = "light",
  connectorHeight,
  style,
  ...rest
}: RouteStopsProps) {
  return (
    <View style={[styles.row, style]} {...rest}>
      <RouteStopsMarkers theme={theme} connectorHeight={connectorHeight} />
      <View style={styles.labels}>
        <View style={styles.labelBlock}>{origin}</View>
        <View style={styles.labelBlock}>{destination}</View>
      </View>
    </View>
  );
}

export interface RouteStopsMarkersProps {
  theme?: RouteStopsTheme;
  connectorHeight?: number;
}

/**
 * Just the marker column (ring/dot + connector + square) with no labels —
 * for embedding inside a screen's own row layout (e.g. alongside editable
 * pickup/dropoff text inputs).
 */
export function RouteStopsMarkers({ theme = "light", connectorHeight = 28 }: RouteStopsMarkersProps) {
  const dark = theme === "dark";
  return (
    <View style={styles.markerCol}>
      <View style={[styles.originRing, dark && styles.originRingDark]}>
        <View style={[styles.originDot, dark && styles.originDotDark]} />
      </View>
      <View style={[styles.connector, { height: connectorHeight }, dark && styles.connectorDark]} />
      <View style={[styles.destSquare, dark && styles.destSquareDark]} />
    </View>
  );
}

RouteStops.Markers = RouteStopsMarkers;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing.md,
  },
  markerCol: {
    width: 20,
    alignItems: "center",
  },
  labels: {
    flex: 1,
    justifyContent: "space-between",
  },
  labelBlock: {
    paddingVertical: 2,
  },
  originRing: {
    width: 20,
    height: 20,
    borderRadius: radii.full,
    backgroundColor: colors.primary[50],
    alignItems: "center",
    justifyContent: "center",
  },
  originRingDark: {
    backgroundColor: "rgba(232, 243, 236, 0.22)",
  },
  originDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
  },
  originDotDark: {
    backgroundColor: colors.primary[400],
  },
  connector: {
    width: 2,
    backgroundColor: colors.border,
    marginVertical: 3,
  },
  connectorDark: {
    backgroundColor: colors.borderDark,
  },
  destSquare: {
    width: 12,
    height: 12,
    borderRadius: radii.sm,
    backgroundColor: colors.ink[900],
  },
  destSquareDark: {
    backgroundColor: colors.white,
  },
});
