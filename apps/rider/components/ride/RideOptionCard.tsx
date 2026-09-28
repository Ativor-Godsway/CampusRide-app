import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { RideType } from "@rida/shared";
import {
  Badge,
  Illustration,
  PressableScale,
  Text,
  colors,
  radii,
  spacing,
  useReduceMotion,
} from "@rida/mobile-shared";

/** Everything the list shows about one ride type. */
export interface RideOption {
  type: RideType;
  title: string;
  description: string;
  /** A short, TRUE fact about the option (seats). No invented ETAs. */
  hint: { icon: keyof typeof Ionicons.glyphMap; label: string };
  farePesewas: number;
  priceLabel: string;
  recommended?: boolean;
}

const CAR_WIDTH = 92;

/**
 * One row of the Bolt-style ride list: the wide car on the left, name,
 * description and a seat hint in the middle, the price right-aligned. The
 * selected row gets a green border and tint, and its car does a small
 * spring "pop" (skipped with Reduce Motion).
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
        option.priceLabel,
        option.description,
        option.hint.label,
        option.recommended ? "Recommended" : null,
      ]
        .filter(Boolean)
        .join(", ")}
      style={[styles.card, selected && styles.cardSelected]}
    >
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <Illustration
          name={option.type === "SHARED" ? "carShared" : "carStandard"}
          width={CAR_WIDTH}
        />
      </Animated.View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text variant="h3" style={styles.title}>
            {option.title}
          </Text>
          {option.recommended ? <Badge label="Recommended" variant="success" /> : null}
        </View>
        <Text variant="bodySmall" color="muted">
          {option.description}
        </Text>
        <View style={styles.hint}>
          <Ionicons name={option.hint.icon} size={13} color={colors.ink[400]} />
          <Text variant="caption" color="subtle">
            {option.hint.label}
          </Text>
        </View>
      </View>

      <Text variant="h3" color={selected ? "primary" : "default"} style={styles.price}>
        {option.priceLabel}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    // Constant 2px border so selecting never shifts the layout.
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  cardSelected: {
    borderColor: colors.primary[500],
    backgroundColor: colors.primary[50],
  },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  title: { flexShrink: 1 },
  hint: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  price: { textAlign: "right", fontVariant: ["tabular-nums"] },
});
