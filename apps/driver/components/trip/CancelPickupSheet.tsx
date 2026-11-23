import { useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import {
  DRIVER_CANCEL_NOTE_MAX,
  DRIVER_CANCEL_REASONS,
  DRIVER_CANCEL_REASON_LABELS,
  type DriverCancelReason,
} from "@rida/shared";
import {
  BottomSheet,
  BottomSheetTextInput,
  Button,
  Chip,
  Text,
  colors,
  radii,
  spacing,
  typography,
} from "@rida/mobile-shared";

/**
 * "Cancel pickup", before the rider is picked up (waiting or arrived), from
 * the trip screen's ⋯ menu and the Stops list: pick a reason ("Other" opens
 * an optional note), then confirm. The rider is told their driver had to
 * cancel and goes straight back to searching for another driver.
 *
 * Not "Rider didn't show" — that one stays where it was (3 minutes after
 * arriving) and cancels the rider's booking.
 */
export function CancelPickupSheet({
  riderName,
  visible,
  onClose,
  onConfirm,
}: {
  /** First name, as on the trip screen. Null: the sheet is closed. */
  riderName: string | null;
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: DriverCancelReason, note: string) => void;
}) {
  const [reason, setReason] = useState<DriverCancelReason | null>(null);
  const [note, setNote] = useState("");
  // Each opening starts afresh.
  useEffect(() => {
    if (visible) {
      setReason(null);
      setNote("");
    }
  }, [visible]);

  const name = riderName || "the rider";
  const confirm = () => {
    if (!reason) return;
    Alert.alert(`Cancel ${name}'s pickup?`, `${name} will be told you had to cancel, and we'll look for another driver for them.`, [
      { text: "Keep", style: "cancel" },
      { text: "Cancel pickup", style: "destructive", onPress: () => onConfirm(reason, reason === "OTHER" ? note : "") },
    ]);
  };

  return (
    <BottomSheet modal visible={visible} onDismiss={onClose} accessibilityLabel="Cancel pickup">
      <View style={styles.body}>
        <View style={styles.heading}>
          <Text variant="title2" accessibilityRole="header">
            Why are you cancelling?
          </Text>
          <Text variant="subhead" color="secondary">
            {`${name} will be matched with another driver.`}
          </Text>
        </View>

        <View style={styles.chips} accessibilityRole="radiogroup">
          {DRIVER_CANCEL_REASONS.map((value) => (
            <Chip
              key={value}
              kind="choice"
              label={DRIVER_CANCEL_REASON_LABELS[value]}
              selected={reason === value}
              onPress={() => setReason(value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: reason === value }}
            />
          ))}
        </View>

        {reason === "OTHER" ? (
          <View style={styles.noteWrap}>
            <BottomSheetTextInput
              value={note}
              onChangeText={setNote}
              placeholder="Tell us more (optional)"
              placeholderTextColor={colors.ink3}
              maxLength={DRIVER_CANCEL_NOTE_MAX}
              multiline
              accessibilityLabel="Tell us more, optional"
              style={styles.note}
            />
            <Text variant="caption" color="tertiary" style={styles.counter}>
              {note.length}/{DRIVER_CANCEL_NOTE_MAX}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button
            label="Cancel pickup"
            variant="danger"
            onPress={confirm}
            disabled={!reason}
            accessibilityHint={reason ? undefined : "Pick a reason first"}
          />
          <Button label="Keep" variant="text" onPress={onClose} />
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[5] },
  heading: { gap: spacing[1] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  noteWrap: { gap: spacing[1] },
  note: {
    minHeight: 72,
    maxHeight: 140,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
    padding: spacing[4],
    fontSize: typography.size.md,
    color: colors.ink,
    textAlignVertical: "top",
  },
  counter: { textAlign: "right" },
  actions: { gap: spacing[2] },
});
