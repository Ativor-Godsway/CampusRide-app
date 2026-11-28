import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { RiderAddedPayload } from "@rida/shared";
import { Button, FadeIn, Text, colors, radii, shadows, spacing } from "@rida/mobile-shared";

/**
 * "Rider added · Ama · Pentagon Block C · 2 seats · +GH₵14 · +3 min" with
 * UNDO for 15 s (fill moving cars first, auto-add). The stop list behind it
 * already has the new rider; Undo takes them off without penalty.
 */
export function RiderAddedBanner({
  added,
  undoing,
  onUndo,
  onDone,
}: {
  added: RiderAddedPayload;
  undoing: boolean;
  onUndo: () => void;
  /** The 15 s are up (or the banner was closed). */
  onDone: () => void;
}) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((added.undoUntil - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.max(0, Math.ceil((added.undoUntil - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) onDone();
    }, 250);
    return () => clearInterval(t);
  }, [added.undoUntil, onDone]);

  return (
    <FadeIn style={styles.wrap}>
      <View style={styles.card} accessibilityRole="alert" accessibilityLiveRegion="assertive" accessibilityLabel={`${added.text}. Undo within ${left} seconds.`}>
        <View style={styles.icon}>
          <Ionicons name="person-add" size={22} color={colors.onBrand} />
        </View>
        <View style={styles.text}>
          <Text variant="title3" color="onDark">
            {`Rider added · ${added.firstName}`}
          </Text>
          <Text variant="subhead" color="onDark2" numberOfLines={2}>
            {added.text.replace(/^Rider added · [^·]+ · /, "")}
          </Text>
        </View>
        <View style={styles.undo}>
          <Button label={left > 0 ? `Undo ${left}` : "Undo"} variant="secondary" size="pill" loading={undoing} disabled={left <= 0} onPress={onUndo} testID="undo-auto-add" />
        </View>
      </View>
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: spacing[3], right: spacing[3], top: spacing[10], zIndex: 50 },
  card: { flexDirection: "row", alignItems: "center", gap: spacing[3], padding: spacing[4], borderRadius: radii.lg, backgroundColor: colors.surfaceDark, ...shadows.float },
  icon: { width: 44, height: 44, borderRadius: radii.full, backgroundColor: colors.green500, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
  undo: { minWidth: 92 },
});
