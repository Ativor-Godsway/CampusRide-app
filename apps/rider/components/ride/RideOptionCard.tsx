import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import type { RideType } from "@rida/shared";
import {
  Illustration,
  PressableScale,
  Text,
  colors,
  radii,
  spacing,
  spokenCedis,
  typography,
  useReduceMotion,
} from "@rida/mobile-shared";

/** Everything the list shows about one ride type. */
export interface RideOption {
  type: RideType;
  title: string;
  /** One short, TRUE line — "Up to 4 riders" / "Private car". */
  subtitle: string;
  farePesewas: number;
  /** Formatted with formatCedis, e.g. "GH₵5". */
  priceLabel: string;
  recommended?: boolean;
}

const CAR_WIDTH = 104;

/**
 * One row of the ride list: a big car · name + one short line · price.
 * The price is the most prominent thing in the row. The selected row gets
 * the green border and a light green tint (unselected rows have none), and
 * its car does a small spring "pop" (skipped with Reduce Motion).
 * "Recommended" is a small green badge beside the name, INSIDE the row, so
 * it looks right whether or not that row is the selected one.
 */
export function RideOptionCard({
  option,
  selected,
  onSelect,
}: {
  option: RideOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const reduceMotion = useReduceMotion();
  const pop = useRef(new Animated.Value(1)).current;
  const wasSelected = useRef(selected);

  useEffect(() => {
    // Only on becoming selected — not on first render, not on deselect.
    const becameSelected = selected && !wasSelected.current;
    wasSelected.current = selected;
    if (!becameSelected || reduceMotion) return;
    pop.setValue(0.9);
    const anim = Animated.spring(pop, {
      toValue: 1,
      friction: 4,
      tension: 160,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [selected, pop, reduceMotion]);

  return (
    <PressableScale
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      accessibilityLabel={[
        option.title,
        spokenCedis(option.farePesewas),
        option.subtitle,
        option.recommended ? "Recommended" : null,
      ]
        .filter(Boolean)
        .join(", ")}
      style={[styles.row, selected && styles.rowSelected]}
    >
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <Illustration
          name={option.type === "SHARED" ? "carShared" : "carStandard"}
          width={CAR_WIDTH}
        />
      </Animated.View>

      {/* No numberOfLines: at normal sizes this fits on one line each; at
          very large accessibility text it wraps instead of being cut off. */}
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text variant="bodyMedium" style={styles.title}>
            {option.title}
          </Text>
          {option.recommended ? (
            <View style={styles.badge} importantForAccessibility="no-hide-descendants">
              <Text style={styles.badgeText}>Recommended</Text>
            </View>
          ) : null}
        </View>
        <Text variant="bodySmall" color="muted">
          {option.subtitle}
        </Text>
      </View>

      <Text
        style={[styles.price, selected && styles.priceSelected]}
        numberOfLines={1}
        importantForAccessibility="no"
      >
        {option.priceLabel}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 80,
    paddingVertical: spacing.xs,
    paddingLeft: spacing.sm,
    paddingRight: spacing.md,
    borderRadius: radii.lg,
    // Constant width, transparent when unselected, so selecting never shifts
    // the layout — unselected rows show no border.
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  rowSelected: {
    borderColor: colors.primary[500],
    backgroundColor: colors.primary[50],
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: spacing.sm,
    rowGap: 2,
  },
  title: { fontSize: typography.size.lg, fontWeight: typography.weight.bold },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.full,
    backgroundColor: colors.primary[50],
    borderWidth: 1,
    borderColor: colors.primary[200],
  },
  badgeText: {
    fontSize: typography.size.xs,
    fontWeight: typography.weight.bold,
    color: colors.primary[500],
  },
  price: {
    fontSize: typography.size["2xl"],
    fontWeight: typography.weight.extrabold,
    letterSpacing: typography.letterSpacing.tight,
    color: colors.ink[900],
    fontVariant: ["tabular-nums"],
  },
  priceSelected: { color: colors.primary[500] },
});
