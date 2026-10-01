import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Card, Text, colors, radii, spacing, typography } from "@rida/mobile-shared";
import { useDriverLocation } from "../../lib/location";
import { useZones } from "../../lib/zones";

/**
 * DEVELOPMENT BUILDS ONLY: pretend to be at a campus zone, so distances, ETAs
 * and automatic arrival can be tested from anywhere. Renders nothing in a
 * release build (useDriverLocation().fake is always null there).
 */
export function FakeLocationCard() {
  const { fake, isFake } = useDriverLocation();
  const { data: zones = [] } = useZones();
  if (!fake) return null;

  const sorted = [...zones].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Card style={styles.card}>
      <Text variant="label" color="muted">DEVELOPER · FAKE LOCATION</Text>
      <Text variant="bodySmall" color="muted">
        {isFake
          ? "The app is pretending to be at the zone below. On a trip, tap “Drive” at the top to move towards the next stop."
          : "Off — using your real GPS. Pick a zone to pretend you're there. Development builds only."}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label="Off (real GPS)" active={!fake.zoneId} onPress={() => fake.setZone(null)} />
        {sorted.map((z) => (
          <Chip key={z.id} label={z.name} active={fake.zoneId === z.id} onPress={() => fake.setZone(z.id)} />
        ))}
      </ScrollView>
    </Card>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <View>
        <Text variant="bodySmall" style={active ? styles.chipTextActive : styles.chipText}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm, marginTop: spacing.lg, borderWidth: 1, borderColor: colors.accent[200] },
  chips: { gap: spacing.xs, paddingRight: spacing.md },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radii.full, backgroundColor: colors.surfaceMuted },
  chipActive: { backgroundColor: colors.accent[500] },
  chipText: { color: colors.ink[600] },
  chipTextActive: { color: colors.white, fontWeight: typography.weight.semibold },
});
