import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { EmptyState, FadeIn, Screen, Text, colors, spacing } from "@rida/mobile-shared";
import { ScheduledCarCard } from "../../components/schedule/ScheduledCarCard";
import { useDriverSchedule } from "../../lib/schedule";

/**
 * Schedule (rides/scheduled.ts): "My scheduled trips" (time, area →
 * destination, seats, fare, Leave by) and "Open scheduled cars" by time, to
 * accept. A scheduled trip starts by itself at its leave-by time and opens
 * like any trip.
 */
export default function ScheduleScreen() {
  const schedule = useDriverSchedule();
  const data = schedule.data;
  return (
    <Screen edges={["top"]} noPadding style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={schedule.isRefetching} onRefresh={() => void schedule.refetch()} />}
      >
        <Text variant="title2" accessibilityRole="header">
          Schedule
        </Text>
        <Text variant="subhead" color="secondary">
          Trips riders booked ahead. Accept one and it&apos;s yours: we tell you when to leave.
        </Text>

        <Text variant="eyebrow" color="secondary" style={styles.section}>
          My scheduled trips
        </Text>
        {data && data.mine.length === 0 ? (
          <Text variant="body" color="secondary">
            None yet.
          </Text>
        ) : null}
        {data?.mine.map((car, i) => (
          <FadeIn key={car.carId} delay={i * 60}>
            <ScheduledCarCard car={car} source="SCHEDULE" />
          </FadeIn>
        ))}

        <Text variant="eyebrow" color="secondary" style={styles.section}>
          Open scheduled cars
        </Text>
        {data && !data.online ? (
          <Text variant="subhead" color="warning">
            Go online to accept scheduled trips.
          </Text>
        ) : null}
        {data && data.open.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState title="No open scheduled cars" message="Cars appear here when riders book ahead and a car fills." />
          </View>
        ) : null}
        {data?.open.map((car, i) => (
          <FadeIn key={car.carId} delay={i * 60}>
            <ScheduledCarCard car={car} source="SCHEDULE" />
          </FadeIn>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.surface },
  content: { padding: spacing.gutter, gap: spacing[3], paddingBottom: spacing[8] },
  section: { marginTop: spacing[3] },
  empty: { paddingVertical: spacing[4] },
});
