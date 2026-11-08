import { StyleSheet, View } from "react-native";
import {
  firstName,
  noShowAvailableAt,
  riderName,
  riderStatusWord,
  stopMarkAction,
  type PassengerStatus,
  type TripStop,
} from "@rida/shared";
import {
  BottomSheet,
  Button,
  ListRow,
  StatusChip,
  Text,
  callPhone,
  colors,
  spacing,
  type PassengerInCar,
  type StatusTone,
} from "@rida/mobile-shared";
import { StopMarker } from "./TripMap";

/** Waiting = warn, In car = brand, Done = neutral. */
const TONE: Record<PassengerStatus, StatusTone> = {
  WAITING: "warn",
  ARRIVED: "warn",
  PICKED_UP: "brand",
  DROPPED_OFF: "neutral",
  CANCELLED: "neutral",
};

/**
 * "Stops" (sketch 8): every remaining stop in route order — the numbered
 * marker as on the map, "Pick up Akosua", where and (for the next stop) how
 * long, and the rider's status as a chip — then the riders already dropped
 * off. Tapping a stop calls that rider.
 *
 * Any stop can be done from here, in any order (the driver reaches Bill
 * before Ali): every open pickup has "Picked up", every drop-off whose rider
 * is on board "Dropped off", and a rider waited for long enough "Didn't
 * show". The screen asks before each one (`onMark`, `onNoShow`).
 */
export function StopListSheet({
  visible,
  onClose,
  stops,
  passengers,
  nextEtaMinutes,
  now,
  onMark,
  onNoShow,
}: {
  visible: boolean;
  onClose: () => void;
  stops: readonly TripStop[];
  /** Every rider on the trip (for the dropped-off rows). */
  passengers: readonly PassengerInCar[];
  nextEtaMinutes: number | null;
  /** Ticks while the sheet is open, for "Didn't show". */
  now: number;
  onMark: (stop: TripStop) => void;
  onNoShow: (stop: TripStop) => void;
}) {
  const done = passengers.filter((p) => p.status === "DROPPED_OFF");
  return (
    <BottomSheet
      modal
      scrollable
      visible={visible}
      onDismiss={onClose}
      maxHeightRatio={0.8}
      accessibilityLabel="Stops"
    >
      <Text variant="title2" accessibilityRole="header">
        Stops
      </Text>
      <View style={styles.list}>
        {stops.map((stop, i) => {
          const name = riderName(stop);
          const word = riderStatusWord(stop.passengerStatus);
          const eta =
            i === 0 && nextEtaMinutes !== null && stop.passengerStatus !== "ARRIVED"
              ? ` · ${nextEtaMinutes} min`
              : "";
          const mark = stopMarkAction(stop);
          const noShowAt = stop.kind === "PICKUP" ? noShowAvailableAt(stop.arrivedAt) : null;
          const canNoShow = stop.passengerStatus === "ARRIVED" && noShowAt !== null && now >= noShowAt;
          return (
            <View key={stop.key}>
              <ListRow
                divider={i > 0}
                title={`${stop.kind === "PICKUP" ? "Pick up" : "Drop off"} ${name}`}
                subtitle={`${stop.label}${eta}`}
                leading={<StopMarker kind={stop.kind} number={i + 1} />}
                trailing={
                  <StatusChip label={word} tone={TONE[stop.passengerStatus]} style={styles.chip} />
                }
                onPress={stop.riderPhone ? () => void callPhone(stop.riderPhone, name) : undefined}
                accessibilityLabel={`Stop ${i + 1}: ${stop.kind === "PICKUP" ? "pick up" : "drop off"} ${name} at ${stop.label}. ${word}.${stop.riderPhone ? " Double-tap to call." : ""}`}
              />
              {mark || canNoShow ? (
                <View style={styles.rowActions}>
                  {mark ? (
                    <Button
                      label={mark === "pickup" ? "Picked up" : "Dropped off"}
                      variant="secondary"
                      size="pill"
                      icon="checkmark"
                      onPress={() => onMark(stop)}
                      accessibilityLabel={`Mark ${name} as ${mark === "pickup" ? "picked up" : "dropped off"}`}
                    />
                  ) : null}
                  {canNoShow ? (
                    <Button
                      label="Didn't show"
                      variant="danger"
                      size="pill"
                      onPress={() => onNoShow(stop)}
                      accessibilityLabel={`${name} didn't show`}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}

        {done.map((p) => (
          <ListRow
            key={p.id}
            divider
            title={firstName(p.riderName) || "Rider"}
            subtitle={p.dropoffLabel ?? p.dropoffZoneName}
            leading={<View style={styles.doneMarker} />}
            trailing={<StatusChip label="Done" tone="neutral" style={styles.chip} />}
          />
        ))}
      </View>
      <Text variant="caption" color="secondary" style={styles.footnote}>
        Order follows the route. Stops can be done in any order.
      </Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: spacing[2] },
  chip: { alignSelf: "center" },
  // Under the row's title, past the 32 px marker and its gap.
  rowActions: { flexDirection: "row", gap: spacing[2], paddingLeft: 32 + spacing[4], paddingBottom: spacing[3] },
  doneMarker: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface3,
  },
  footnote: { marginTop: spacing[3] },
});
