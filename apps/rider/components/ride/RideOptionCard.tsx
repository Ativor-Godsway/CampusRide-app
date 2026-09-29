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

const CAR_WIDTH = 72;

/**
 * One compact row of the ride list: car · name + one-line subtitle · price.
 * The price is the most prominent thing in the row. The selected row gets
 * the green border and a light green tint (unselected rows have none), and
 * its car does a small spring "pop" (skipped with Reduce Motion).
 * "Recommended" is a small tag sitting on the row's top edge.
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
    <View style={option.recommended ? styles.withTag : undefined}>
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

        {/* No numberOfLines: at normal sizes these fit on one line; at very
            large accessibility text they wrap instead of being cut off. */}
        <View style={styles.body}>
          <Text variant="bodyMedium" style={styles.title}>
            {option.title}
          </Text>
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

      {option.recommended ? (
        <View
          style={styles.tag}
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={styles.tagText}>Recommended</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Room for the tag that sits on the row's top edge.
  withTag: { paddingTop: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
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
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: typography.size.lg, fontWeight: typography.weight.bold },
  price: {
    fontSize: typography.size["2xl"],
    fontWeight: typography.weight.extrabold,
    letterSpacing: typography.letterSpacing.tight,
    color: colors.ink[900],
    fontVariant: ["tabular-nums"],
  },
  priceSelected: { color: colors.primary[500] },
  tag: {
    position: "absolute",
    top: 0,
    left: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.primary[200],
  },
  tagText: {
    fontSize: typography.size.xs,
    fontWeight: typography.weight.bold,
    color: colors.primary[500],
  },
});
