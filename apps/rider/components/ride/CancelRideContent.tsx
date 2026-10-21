import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  RIDER_CANCEL_NOTE_MAX,
  RIDER_CANCEL_REASON_LABELS,
  riderCancelReasonsFor,
  type RiderCancelReason,
  type RideType,
} from "@rida/shared";
import {
  BottomSheetTextInput,
  Button,
  Chip,
  FadeIn,
  Text,
  colors,
  radii,
  spacing,
  typography,
} from "@rida/mobile-shared";

export interface SwitchOffer {
  toType: RideType;
  /** "Switch to Ride alone" / "Switch to Shared" — no explanation needed. */
  label: string;
  /** The new fare, e.g. "GH₵15". */
  priceLabel: string;
  /** Spoken form of the fare, for screen readers. */
  priceSpoken: string;
}

type Step = "confirm" | "reason";

/**
 * Cancelling a ride, in two short steps so an accidental tap costs nothing.
 * It takes the place of the ride sheet's content — never a second sheet over
 * a dimmed one — and starts again at step 1 each time it's shown (the caller
 * mounts it fresh).
 *
 * 1. "Cancel this ride?" — the other ride type at its price as one tonal
 *    row, then "Keep waiting" (primary) and "Cancel ride" (red text).
 * 2. Only after "Cancel ride": "Why are you cancelling?" — one tap on a
 *    reason chip is required, typing never is ("Other" reveals an optional
 *    note). "Cancel ride" confirms; "Back" returns to step 1.
 */
export function CancelRideContent({
  stage,
  switchOffer,
  switching,
  cancelling,
  onKeep,
  onSwitch,
  onConfirmCancel,
}: {
  stage: "searching" | "driver_assigned";
  switchOffer: SwitchOffer | null;
  switching: boolean;
  cancelling: boolean;
  /** Back to the ride: the sheet shows what it showed before. */
  onKeep: () => void;
  onSwitch: (toType: RideType) => void;
  onConfirmCancel: (reason: RiderCancelReason, note: string) => void;
}) {
  const [step, setStep] = useState<Step>("confirm");
  const [reason, setReason] = useState<RiderCancelReason | null>(null);
  const [note, setNote] = useState("");

  const busy = switching || cancelling;

  if (step === "confirm") {
    return (
      <FadeIn key="confirm" style={styles.step}>
        <Text variant="title2" accessibilityRole="header">
          Cancel this ride?
        </Text>

        {switchOffer ? (
          <Button
            label={`${switchOffer.label} · ${switchOffer.priceLabel}`}
            variant="secondary"
            icon="swap-horizontal"
            onPress={() => onSwitch(switchOffer.toType)}
            loading={switching}
            disabled={busy}
            accessibilityLabel={`${switchOffer.label}, ${switchOffer.priceSpoken}`}
          />
        ) : null}

        <View style={styles.actions}>
          <Button
            label={stage === "searching" ? "Keep waiting" : "Keep my ride"}
            onPress={onKeep}
            disabled={busy}
          />
          <Button
            label="Cancel ride"
            variant="danger"
            onPress={() => setStep("reason")}
            disabled={busy}
          />
        </View>
      </FadeIn>
    );
  }

  return (
    <FadeIn key="reason" style={styles.step}>
      <Text variant="title2" accessibilityRole="header">
        Why are you cancelling?
      </Text>

      <View style={styles.chips} accessibilityRole="radiogroup">
        {riderCancelReasonsFor(stage).map((value) => (
          <Chip
            key={value}
            kind="choice"
            label={RIDER_CANCEL_REASON_LABELS[value]}
            selected={reason === value}
            // The chip plays the selection haptic itself.
            onPress={() => setReason(value)}
            disabled={busy}
            accessibilityRole="radio"
            accessibilityState={{ checked: reason === value, disabled: busy }}
          />
        ))}
      </View>

      {reason === "OTHER" ? (
        <View style={styles.noteWrap}>
          {/* The sheet's own input: typing moves the sheet above the keyboard. */}
          <BottomSheetTextInput
            value={note}
            onChangeText={setNote}
            placeholder="Tell us more (optional)"
            placeholderTextColor={colors.ink3}
            maxLength={RIDER_CANCEL_NOTE_MAX}
            multiline
            editable={!busy}
            accessibilityLabel="Tell us more, optional"
            style={styles.note}
          />
          <Text variant="caption" color="tertiary" style={styles.counter}>
            {note.length}/{RIDER_CANCEL_NOTE_MAX}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          label="Cancel ride"
          variant="danger"
          onPress={() => reason && onConfirmCancel(reason, note)}
          disabled={!reason}
          loading={cancelling}
          accessibilityHint={reason ? undefined : "Pick a reason first"}
        />
        <Button
          label="Back"
          variant="text"
          onPress={() => setStep("confirm")}
          disabled={cancelling}
        />
      </View>
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  step: { gap: spacing[5] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  noteWrap: { gap: spacing[1] },
  // A filled field, as Input (docs/design-system.md): surface-2, radius 14.
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
