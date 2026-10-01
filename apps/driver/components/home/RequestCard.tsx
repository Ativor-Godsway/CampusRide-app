import { StyleSheet, View } from "react-native";
import { formatDistance, requestedAgo, spokenCedis, type RideType } from "@rida/shared";
import { Badge, Button, Card, Text, colors, formatCedis, spacing, typography } from "@rida/mobile-shared";

/** One request on Home, already measured from the driver. */
export interface HomeRequest {
  rideId: string;
  type: RideType;
  seats?: number;
  farePesewas: number;
  pickupZoneId: string;
  pickupZoneName: string;
  dropoffZoneName: string;
  createdAt: string;
  riderFirstName?: string;
  distanceMeters: number | null;
}

function typeLabel(item: HomeRequest): string {
  return item.type === "LONE" ? "Private" : `Shared · ${item.seats ?? 1}`;
}

function spoken(item: HomeRequest): string {
  const kind = item.type === "LONE" ? "Private ride" : `Shared ride, ${item.seats ?? 1} rider${(item.seats ?? 1) === 1 ? "" : "s"}`;
  const who = item.riderFirstName ? `${item.riderFirstName}, ` : "";
  const distance = item.distanceMeters !== null ? `${formatDistance(item.distanceMeters)} away, ` : "";
  return `${who}${kind}, ${distance}${spokenCedis(item.farePesewas)}. From ${item.pickupZoneName} to ${item.dropoffZoneName}. ${requestedAgo(item.createdAt)}.`;
}

/**
 * A request on Home: type + seats, distance, price, pickup → drop-off, who
 * and how long ago, then the action — Accept, or (on a shared trip) See
 * route + Add. Rows wrap instead of truncating, so large text sizes work.
 */
export function RequestCard({
  item,
  onAccept,
  onSeeRoute,
  onAdd,
}: {
  item: HomeRequest;
  onAccept?: () => void;
  onSeeRoute?: () => void;
  onAdd?: () => void;
}) {
  return (
    <Card style={styles.card}>
      <View accessible accessibilityLabel={spoken(item)} style={styles.body}>
        <View style={styles.top}>
          <Badge label={typeLabel(item)} variant={item.type === "SHARED" ? "success" : "default"} />
          {item.distanceMeters !== null ? (
            <Text variant="caption" color="muted">
              {formatDistance(item.distanceMeters)}
            </Text>
          ) : null}
          <View style={styles.spacer} />
          <Text variant="h3" style={styles.price}>
            {formatCedis(item.farePesewas)}
          </Text>
        </View>
        <Text variant="bodyMedium" style={styles.route}>
          {item.pickupZoneName} → {item.dropoffZoneName}
        </Text>
      </View>
      <View style={styles.bottom}>
        <Text variant="caption" color="muted" style={styles.meta}>
          {item.riderFirstName ? `${item.riderFirstName} · ` : ""}
          {requestedAgo(item.createdAt)}
        </Text>
        <View style={styles.buttons}>
          {onSeeRoute ? (
            <Button
              label="See route"
              variant="secondary"
              fullWidth={false}
              onPress={onSeeRoute}
              accessibilityLabel={`See the route with ${item.riderFirstName ?? "this rider"} added`}
            />
          ) : null}
          {onAdd ? (
            <Button
              label="Add"
              fullWidth={false}
              onPress={onAdd}
              accessibilityLabel={`Add ${item.riderFirstName ?? "this rider"} to your car`}
            />
          ) : null}
          {onAccept ? (
            <Button
              label="Accept"
              fullWidth={false}
              onPress={onAccept}
              accessibilityLabel={`Accept ride from ${item.pickupZoneName} to ${item.dropoffZoneName}`}
            />
          ) : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  body: { gap: spacing.xs },
  top: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  spacer: { flex: 1 },
  price: { fontWeight: typography.weight.extrabold, color: colors.ink[900] },
  route: { fontWeight: typography.weight.semibold },
  bottom: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  meta: { flex: 1, minWidth: 120 },
  buttons: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
});
