import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { clockTime, cloudinaryAvatar, initialsOf } from "@rida/shared";
import {
  Button,
  IconButton,
  StatusChip,
  Text,
  callPhone,
  colors,
  radii,
  shadows,
  spacing,
  textPhone,
  type RideDriverInfo,
} from "@rida/mobile-shared";
import { carDescription } from "../../lib/shareTrip";

/** "Kwame" from "Kwame Mensah". */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "6:38 PM": when the driver should get there, `minutes` from now. */
export function arrivalClock(minutes: number, now = new Date()): string {
  return clockTime(now.getTime() + Math.round(minutes) * 60_000);
}

/** Whole minutes for the big number: never "0 min" while the car is still coming. */
function etaLabel(minutes: number): string {
  return `${Math.max(1, Math.round(minutes))} min`;
}

// ── Driver row ────────────────────────────────────────────────────────────────

export function DriverAvatar({ driver, size }: { driver: RideDriverInfo; size: number }) {
  const [failed, setFailed] = useState(false);
  const initials = initialsOf(driver.name) || "?";
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={[styles.avatar, round]}>
      {driver.photoUrl && !failed ? (
        <Image
          source={{ uri: cloudinaryAvatar(driver.photoUrl, size) }}
          style={round}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={200}
          onError={() => setFailed(true)}
        />
      ) : (
        <Text variant="title3" color="brand">
          {initials}
        </Text>
      )}
    </View>
  );
}

/**
 * docs/design-system.md, "Driver card (rider side)": the 56 avatar with an
 * amber-star rating badge, first name, car colour and model, and the plate
 * in its frame so the rider can match it to the real car. `compact` (on the
 * trip) drops the badge and uses a smaller avatar.
 */
export function DriverRow({
  driver,
  compact = false,
}: {
  driver: RideDriverInfo;
  compact?: boolean;
}) {
  const car = carDescription(driver);
  const name = firstNameOf(driver.name);
  const rating = driver.rating != null ? driver.rating.toFixed(1) : null;
  return (
    <View
      style={styles.driverRow}
      accessible
      accessibilityLabel={[
        `Your driver, ${name}`,
        rating && !compact ? `rated ${rating}` : null,
        car || null,
        driver.plate ? `plate ${driver.plate}` : null,
      ]
        .filter(Boolean)
        .join(", ")}
    >
      <View style={!compact && rating ? styles.avatarWithBadge : undefined}>
        <DriverAvatar driver={driver} size={compact ? 44 : 56} />
        {!compact && rating ? (
          <View style={styles.ratingBadge}>
            <Ionicons name="star" size={11} color={colors.amber400} />
            <Text variant="caption" style={styles.ratingText} tabular>
              {rating}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.driverText}>
        <Text variant="title3" numberOfLines={1}>
          {name}
        </Text>
        {car ? (
          <Text variant="subhead" color="secondary" numberOfLines={2}>
            {car}
          </Text>
        ) : null}
      </View>
      {driver.plate ? (
        <View style={styles.plateFrame}>
          <Text variant="plate" numberOfLines={1}>
            {driver.plate}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Round actions ─────────────────────────────────────────────────────────────

/** Call · Message · Share trip · Safety (on the trip: Share trip · Safety). */
function TripActions({
  driver,
  onShare,
  onSafety,
  reachDriver,
}: {
  driver: RideDriverInfo;
  onShare: () => void;
  onSafety: () => void;
  /** Call and Message: while the driver is coming, not once the rider is in the car. */
  reachDriver: boolean;
}) {
  const name = firstNameOf(driver.name);
  return (
    <View style={styles.actions}>
      {reachDriver ? (
        <>
          <View style={styles.action}>
            <IconButton
              icon="call-outline"
              label="Call"
              accessibilityLabel={`Call ${name}`}
              onPress={() => void callPhone(driver.phone, name)}
            />
          </View>
          <View style={styles.action}>
            <IconButton
              icon="chatbox-outline"
              label="Message"
              accessibilityLabel={`Text ${name}`}
              onPress={() => void textPhone(driver.phone, name)}
            />
          </View>
        </>
      ) : null}
      <View style={styles.action}>
        <IconButton
          icon="share-outline"
          label="Share trip"
          accessibilityLabel="Share trip"
          onPress={onShare}
        />
      </View>
      <View style={styles.action}>
        <IconButton
          icon="shield-checkmark-outline"
          label="Safety"
          accessibilityLabel="Safety: share your trip or call emergency services"
          onPress={onSafety}
        />
      </View>
    </View>
  );
}

// ── States ────────────────────────────────────────────────────────────────────

interface Shared {
  driver: RideDriverInfo;
  onShare: () => void;
  onSafety: () => void;
}

/** Mockup 06: "DRIVER ON THE WAY", the ETA as the hero, the driver, and how to reach them. */
export function DriverOnTheWayContent({
  driver,
  etaMinutes,
  onShare,
  onSafety,
  onCancel,
}: Shared & {
  /** Minutes until the driver reaches the pickup; null until the first GPS fix. */
  etaMinutes: number | null;
  onCancel: () => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.header} accessibilityLiveRegion="polite">
        <Text variant="eyebrow" color="secondary">
          Driver on the way
        </Text>
        {etaMinutes !== null ? (
          <View
            style={styles.etaRow}
            accessible
            accessibilityLabel={`${etaLabel(etaMinutes)} away. Arrives about ${arrivalClock(etaMinutes)}`}
          >
            <Text variant="display" tabular>
              {etaLabel(etaMinutes)}
            </Text>
            <Text variant="body" color="secondary" tabular style={styles.arrives}>
              Arrives {arrivalClock(etaMinutes)}
            </Text>
          </View>
        ) : (
          <Text variant="title1">On the way</Text>
        )}
      </View>
      <View style={styles.divider} />
      <DriverRow driver={driver} />
      <TripActions driver={driver} onShare={onShare} onSafety={onSafety} reachDriver />
      <Button label="Cancel ride" variant="danger" onPress={onCancel} />
    </View>
  );
}

/** The driver is at the pickup: who to look for, and where. */
export function DriverArrivedContent({
  driver,
  pickup,
  onShare,
  onSafety,
  onCancel,
}: Shared & {
  /** Where the pickup is (pickupPlace); null when there's no place name for it. */
  pickup: { name: string; at: boolean } | null;
  onCancel: () => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.header} accessibilityLiveRegion="polite">
        <Text variant="eyebrow" color="brand">
          Your driver is here
        </Text>
        <Text variant="title1" accessibilityRole="header">
          {firstNameOf(driver.name)} is waiting
        </Text>
        <Text variant="subhead" color="secondary">
          {!pickup
            ? "Meet at your pickup point"
            : pickup.at
              ? `Meet at ${pickup.name}`
              : `Meet near ${pickup.name}`}
        </Text>
      </View>
      <View style={styles.divider} />
      <DriverRow driver={driver} />
      <TripActions driver={driver} onShare={onShare} onSafety={onSafety} reachDriver />
      <Button label="Cancel ride" variant="danger" onPress={onCancel} />
    </View>
  );
}

/** In the car: how long to the drop-off, and (shared) any stop before it. No cancel. */
export function InRideContent({
  driver,
  dropoffName,
  etaMinutes,
  stopsBefore,
  onShare,
  onSafety,
}: Shared & {
  dropoffName: string;
  /** Minutes to the drop-off; null when the driver's position isn't known. */
  etaMinutes: number | null;
  /** Shared rides: stops the car makes before this rider's drop-off. */
  stopsBefore: number | null;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.header} accessibilityLiveRegion="polite">
        <Text variant="eyebrow" color="brand">
          On your way
        </Text>
        <Text variant={etaMinutes !== null ? "display" : "title1"} tabular>
          {etaMinutes !== null ? etaLabel(etaMinutes) : "On the way"}
        </Text>
        <Text variant="subhead" color="secondary">
          to {dropoffName}
        </Text>
        {stopsBefore ? (
          <StatusChip
            tone="neutral"
            label={`${stopsBefore} more stop${stopsBefore === 1 ? "" : "s"} before yours`}
            style={styles.stopsChip}
          />
        ) : null}
      </View>
      <View style={styles.divider} />
      <DriverRow driver={driver} compact />
      <TripActions driver={driver} onShare={onShare} onSafety={onSafety} reachDriver={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[4] },
  header: { gap: spacing[1] },
  etaRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing[3],
  },
  arrives: { flexShrink: 1, textAlign: "right" },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  stopsChip: { alignSelf: "flex-start", marginTop: spacing[2] },
  // ── Driver row
  driverRow: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  // Room under the avatar for the half of the badge that hangs below it.
  avatarWithBadge: { paddingBottom: spacing[2] },
  avatar: {
    backgroundColor: colors.green50,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  ratingBadge: {
    position: "absolute",
    bottom: 0,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  ratingText: { fontWeight: "700", color: colors.ink },
  driverText: { flex: 1, gap: 2 },
  // The plate frame: white, 1.5 ink border, radius-sm (docs/design-system.md).
  plateFrame: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  // ── Actions
  actions: { flexDirection: "row" },
  action: { flex: 1, alignItems: "center" },
});
