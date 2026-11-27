import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PressableScale, Text, colors, radii, spacing } from "@rida/mobile-shared";

export const SCHEDULE_AHEAD_LINE = "Book your ride to class ahead. Join a car going your way.";

/**
 * Home's way into Schedule mode (under "Where to?"): where to → the time →
 * confirm. A calm green card with a calendar mark and one line.
 */
export function ScheduleAheadCard({ onPress }: { onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Schedule ahead. ${SCHEDULE_AHEAD_LINE}`}
      style={styles.card}
      testID="schedule-ahead"
    >
      <View style={styles.icon}>
        <Ionicons name="calendar" size={22} color={colors.onBrand} />
      </View>
      <View style={styles.text}>
        <Text variant="bodyStrong" style={styles.title}>
          Schedule ahead
        </Text>
        <Text variant="subhead" style={styles.line}>
          {SCHEDULE_AHEAD_LINE}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.green700} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radii.lg,
    backgroundColor: colors.green50,
    borderWidth: 1,
    borderColor: colors.green100,
  },
  icon: { width: 44, height: 44, borderRadius: radii.md, backgroundColor: colors.green500, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
  title: { color: colors.green700 },
  line: { color: colors.green700 },
});
