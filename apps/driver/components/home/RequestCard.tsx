import { StyleSheet, View } from "react-native";
import { formatDistance, requestedAgo, spokenCedis, type RideType } from "@rida/shared";
import { Button, Card, StatusChip, Text, colors, formatCedis, spacing } from "@rida/mobile-shared";

/** One request on Home, already measured from the driver. */
export interface HomeRequest {
  rideId: string;
  type: RideType;
  seats?: number;
  farePesewas: number;
  pickupZoneId: string;
  pickupZoneName: string;
  dropoffZoneName: string;
  /** Where the rider asked to go, by name — never coordinates before accepting. Absent from older servers. */
  pickupPlaceName?: string;
  dropoffPlaceName?: string;
  createdAt: string;
  riderFirstName?: string;
  distanceMeters: number | null;
}

/** "Night Market → Balme Library": place names, or zone names from an older server. */
function from(item: HomeRequest): string {
  return item.pickupPlaceName ?? item.pickupZoneName;
}
function to(item: HomeRequest): string {
  return item.dropoffPlaceName ?? item.dropoffZoneName;
}

function typeLabel(item: HomeRequest): string {
  return item.type === "LONE" ? "Private" : `Shared · ${item.seats ?? 1}`;
}

function spoken(item: HomeRequest): string {
  const kind = item.type === "LONE" ? "Private ride" : `Shared ride, ${item.seats ?? 1} rider${(item.seats ?? 1) === 1 ? "" : "s"}`;
  const who = item.riderFirstName ? `${item.riderFirstName}, ` : "";
  const distance = item.distanceMeters !== null ? `${formatDistance(item.distanceMeters)} away, ` : "";
  return `${who}${kind}, ${distance}${spokenCedis(item.farePesewas)}. From ${from(item)} to ${to(item)}. ${requestedAgo(item.createdAt)}.`;
}

/**
 * A request in Home's sheet, compact: type chip + distance and the price on
 * top, pickup → drop-off, who and how long ago, then the action — Accept,
 * or (on a shared trip) See route + Add, as small pills. Rows wrap instead
 * of truncating, so large text sizes work.
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
    <Card variant="filled" style={styles.card}>
      <View accessible accessibilityLabel={spoken(item)} style={styles.body}>
        <View style={styles.top}>
          <StatusChip
            label={typeLabel(item)}
            tone={item.type === "SHARED" ? "brand" : "neutral"}
            // White on the grey card, so a neutral chip still reads as one.
            style={item.type === "SHARED" ? undefined : styles.neutralChip}
          />
          {item.distanceMeters !== null ? (
            <Text variant="subhead" color="secondary">
              {formatDistance(item.distanceMeters)}
            </Text>
          ) : null}
          <View style={styles.spacer} />
          <Text variant="title3" tabular>
            {formatCedis(item.farePesewas)}
          </Text>
        </View>
        <Text variant="bodyStrong">
          {from(item)} → {to(item)}
        </Text>
      </View>
      <View style={styles.bottom}>
        <Text variant="subhead" color="secondary" style={styles.meta}>
          {item.riderFirstName ? `${item.riderFirstName} · ` : ""}
          {requestedAgo(item.createdAt)}
        </Text>
        <View style={styles.buttons}>
          {onSeeRoute ? (
            <Button
              label="See route"
              variant="secondary"
              size="pill"
              onPress={onSeeRoute}
              accessibilityLabel={`See the route with ${item.riderFirstName ?? "this rider"} added`}
            />
          ) : null}
          {onAdd ? (
            <Button
              label="Add"
              size="pill"
              onPress={onAdd}
              accessibilityLabel={`Add ${item.riderFirstName ?? "this rider"} to your car`}
            />
          ) : null}
          {onAccept ? (
            <Button
              label="Accept"
              size="pill"
              onPress={onAccept}
              accessibilityLabel={`Accept ride from ${from(item)} to ${to(item)}`}
            />
          ) : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing[3] },
  body: { gap: spacing[2] },
  top: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing[2] },
  spacer: { flex: 1 },
  neutralChip: { backgroundColor: colors.surface },
  bottom: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing[2] },
  meta: { flex: 1, minWidth: 120 },
  buttons: { flexDirection: "row", gap: spacing[2], flexWrap: "wrap" },
});
