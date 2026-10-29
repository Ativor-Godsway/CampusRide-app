import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  countdownWords,
  launchClockTime,
  launchDay,
  type CountdownParts,
} from "@rida/shared";
import { Text } from "../design/components/Text";
import { colors, radii, spacing, withAlpha } from "../design/tokens";

interface CountdownProps {
  launchAt: Date;
  parts: CountdownParts;
  style?: StyleProp<ViewStyle>;
}

/**
 * Rider Home during the launch countdown: the days, hours and minutes to the
 * public launch, on the brand green. Read out as one sentence.
 */
export function LaunchCountdownCard({ launchAt, parts, style }: CountdownProps) {
  const when = `${launchDay(launchAt)} at ${launchClockTime(launchAt)}`;
  return (
    <View
      style={[styles.card, style]}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`CampusRide opens in ${countdownWords(parts)}, on ${when}. You can look around until then.`}
    >
      <View style={styles.eyebrow}>
        <Ionicons name="rocket-outline" size={16} color={colors.onBrand} />
        <Text variant="eyebrow" color="onBrand">
          Opening soon
        </Text>
      </View>
      <View style={styles.units}>
        <Unit value={parts.days} label={parts.days === 1 ? "day" : "days"} />
        <Unit value={parts.hours} label={parts.hours === 1 ? "hour" : "hours"} />
        <Unit value={parts.minutes} label={parts.minutes === 1 ? "minute" : "minutes"} />
      </View>
      <Text variant="subhead" color="onBrand" style={styles.when}>
        CampusRide opens {when}. Have a look around: you can book from then.
      </Text>
    </View>
  );
}

function Unit({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.unit}>
      <Text variant="title1" color="onBrand" tabular>
        {String(value).padStart(2, "0")}
      </Text>
      <Text variant="caption" color="onBrand">
        {label}
      </Text>
    </View>
  );
}

/** Driver Home during the countdown: one small line, "Public launch in 2 days, 4 hours and 12 minutes". */
export function LaunchBanner({ parts, style }: Omit<CountdownProps, "launchAt">) {
  return (
    <View style={[styles.banner, style]} accessibilityRole="text">
      <Ionicons name="rocket-outline" size={18} color={colors.green700} />
      <Text variant="subhead" style={styles.bannerText}>
        Public launch in {countdownWords(parts)}. Until then, only early-access riders can book.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.green500,
    borderRadius: radii.lg,
    padding: spacing[4],
    gap: spacing[3],
  },
  eyebrow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
  },
  units: {
    flexDirection: "row",
    gap: spacing[2],
  },
  unit: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing[2],
    borderRadius: radii.md,
    backgroundColor: withAlpha(colors.onBrand, 0.14),
  },
  when: {
    opacity: 0.92,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radii.md,
    backgroundColor: colors.green50,
  },
  bannerText: {
    flex: 1,
    color: colors.green700,
  },
});
