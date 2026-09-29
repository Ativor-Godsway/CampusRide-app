import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import {
  RIDER_CANCEL_NOTE_MAX,
  RIDER_CANCEL_REASON_LABELS,
  riderCancelReasonsFor,
  type RiderCancelReason,
  type RideType,
} from "@rida/shared";
import {
  Button,
  FadeIn,
  Illustration,
  PressableScale,
  Text,
  colors,
  radii,
  spacing,
  typography,
} from "@rida/mobile-shared";
import { haptics } from "../../lib/haptics";

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
 * Cancelling a ride, in two short steps so an accidental tap costs nothing:
 *
 * 1. "Cancel this ride?" — a compact switch row (the other ride type at its
 *    price), then "Keep waiting" (primary) and "Cancel ride" (red outline).
 * 2. Only after "Cancel ride": "Why are you cancelling?" — one tap on a
 *    reason chip is required, typing never is ("Other" reveals an optional
 *    note). "Cancel ride" (solid red) confirms; "Back" returns to step 1.
 */
export function CancelRideSheet({
  visible,
  stage,
  switchOffer,
  switching,
  cancelling,
  onDismiss,
  onSwitch,
  onConfirmCancel,
}: {
  visible: boolean;
  stage: "searching" | "driver_assigned";
  switchOffer: SwitchOffer | null;
  switching: boolean;
  cancelling: boolean;
  onDismiss: () => void;
  onSwitch: (toType: RideType) => void;
  onConfirmCancel: (reason: RiderCancelReason, note: string) => void;
}) {
  const sheetRef = useRef<BottomSheet>(null);
  const { height } = useWindowDimensions();
  const [step, setStep] = useState<Step>("confirm");
  const [reason, setReason] = useState<RiderCancelReason | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (visible) {
      // A fresh start every time it opens.
      setStep("confirm");
      setReason(null);
      setNote("");
      sheetRef.current?.expand();
    } else {
      sheetRef.current?.close();
    }
  }, [visible]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );

  const busy = switching || cancelling;
  const keepLabel = stage === "searching" ? "Keep waiting" : "Keep my ride";

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      enablePanDownToClose={!busy}
      enableDynamicSizing
      maxDynamicContentSize={height * 0.9}
      onClose={onDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
      handleIndicatorStyle={styles.handle}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetScrollView contentContainerStyle={styles.content} accessibilityViewIsModal>
        {step === "confirm" ? (
          <FadeIn key="confirm" style={styles.step}>
            <Text variant="h2" accessibilityRole="header">
              Cancel this ride?
            </Text>

            {switchOffer ? (
              <PressableScale
                onPress={() => onSwitch(switchOffer.toType)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`${switchOffer.label}, ${switchOffer.priceSpoken}`}
                accessibilityState={{ busy: switching, disabled: busy }}
                style={styles.switchRow}
              >
                <Illustration
                  name={switchOffer.toType === "LONE" ? "carStandard" : "carShared"}
                  width={56}
                />
                <Text variant="bodyMedium" style={styles.switchLabel}>
                  {switchOffer.label}
                </Text>
                <Text style={styles.switchPrice} numberOfLines={1}>
                  {switchOffer.priceLabel}
                </Text>
                <Ionicons name="swap-horizontal" size={20} color={colors.primary[500]} />
              </PressableScale>
            ) : null}

            <View style={styles.actions}>
              <Button
                label={keepLabel}
                size="lg"
                onPress={() => sheetRef.current?.close()}
                disabled={busy}
              />
              <Button
                label="Cancel ride"
                variant="dangerSecondary"
                onPress={() => setStep("reason")}
                disabled={busy}
              />
            </View>
          </FadeIn>
        ) : (
          <FadeIn key="reason" style={styles.step}>
            <Text variant="h2" accessibilityRole="header">
              Why are you cancelling?
            </Text>

            <View style={styles.chips} accessibilityRole="radiogroup">
              {riderCancelReasonsFor(stage).map((value) => {
                const selected = reason === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => {
                      haptics.selection();
                      setReason(value);
                    }}
                    disabled={busy}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected, disabled: busy }}
                    accessibilityLabel={RIDER_CANCEL_REASON_LABELS[value]}
                    style={({ pressed }) => [
                      styles.chip,
                      selected && styles.chipSelected,
                      pressed && styles.chipPressed,
                    ]}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                      {RIDER_CANCEL_REASON_LABELS[value]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {reason === "OTHER" ? (
              <View style={styles.noteWrap}>
                <BottomSheetTextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Tell us more (optional)"
                  placeholderTextColor={colors.ink[300]}
                  maxLength={RIDER_CANCEL_NOTE_MAX}
                  multiline
                  editable={!busy}
                  accessibilityLabel="Tell us more, optional"
                  style={styles.note}
                />
                <Text variant="caption" color="muted" style={styles.counter}>
                  {note.length}/{RIDER_CANCEL_NOTE_MAX}
                </Text>
              </View>
            ) : null}

            <View style={styles.actions}>
              <Button
                label="Cancel ride"
                variant="danger"
                size="lg"
                onPress={() => reason && onConfirmCancel(reason, note)}
                disabled={!reason}
                loading={cancelling}
                accessibilityHint={reason ? undefined : "Pick a reason first"}
              />
              <Button
                label="Back"
                variant="neutral"
                onPress={() => setStep("confirm")}
                disabled={cancelling}
              />
            </View>
          </FadeIn>
        )}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
  },
  handle: { backgroundColor: colors.borderStrong, width: 40, height: 5 },
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.xs, paddingBottom: spacing["2xl"] },
  step: { gap: spacing.lg },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.primary[200],
    backgroundColor: colors.primary[50],
  },
  switchLabel: { flex: 1, fontWeight: typography.weight.bold },
  switchPrice: {
    fontSize: typography.size.lg,
    fontWeight: typography.weight.extrabold,
    color: colors.primary[500],
    fontVariant: ["tabular-nums"],
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  chipSelected: { borderColor: colors.primary[500], backgroundColor: colors.primary[50] },
  chipPressed: { opacity: 0.7 },
  chipText: {
    fontSize: typography.size.sm,
    fontWeight: typography.weight.medium,
    color: colors.ink[900],
  },
  chipTextSelected: { color: colors.primary[500], fontWeight: typography.weight.bold },
  noteWrap: { gap: spacing.xs },
  note: {
    minHeight: 72,
    maxHeight: 140,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    fontSize: typography.size.md,
    color: colors.ink[900],
    textAlignVertical: "top",
  },
  counter: { textAlign: "right" },
  actions: { gap: spacing.md },
});
