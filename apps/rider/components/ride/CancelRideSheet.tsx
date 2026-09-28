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
  /** e.g. "Switch to Ride alone — GHS 15, no waiting for others" */
  label: string;
}

/**
 * "Cancel this ride?" — replaces the old instant cancel.
 *
 * The rider must pick a reason (one tap); typing is never required ("Other"
 * only reveals an optional note). While searching, it first offers the
 * other ride type at its real price. "Keep waiting" is the big, safe,
 * primary action; "Cancel ride" is the red outline one, enabled once a
 * reason is picked.
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
  const [reason, setReason] = useState<RiderCancelReason | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (visible) {
      // A fresh question every time it opens.
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
  const reasons = riderCancelReasonsFor(stage);
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
        <Text variant="h2" accessibilityRole="header">
          Cancel this ride?
        </Text>

        {switchOffer ? (
          <PressableScale
            onPress={() => onSwitch(switchOffer.toType)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={switchOffer.label}
            accessibilityState={{ busy: switching, disabled: busy }}
            style={styles.offer}
          >
            <Illustration
              name={switchOffer.toType === "LONE" ? "carStandard" : "carShared"}
              width={64}
            />
            <View style={styles.offerText}>
              <Text variant="label" color="primary">
                OR SWITCH INSTEAD
              </Text>
              <Text variant="bodyMedium">{switchOffer.label}</Text>
            </View>
            <Ionicons name="swap-horizontal" size={22} color={colors.primary[600]} />
          </PressableScale>
        ) : null}

        <Text variant="bodyMedium" style={styles.question}>
          Why are you cancelling?
        </Text>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {reasons.map((value) => {
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
                {selected ? (
                  <Ionicons name="checkmark" size={14} color={colors.primary[700]} />
                ) : null}
                <Text variant="bodySmall" style={selected ? styles.chipTextSelected : undefined}>
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
            <Text variant="caption" color="subtle" style={styles.counter}>
              {note.length}/{RIDER_CANCEL_NOTE_MAX}
            </Text>
          </View>
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
            onPress={() => reason && onConfirmCancel(reason, note)}
            disabled={!reason || switching}
            loading={cancelling}
            accessibilityHint={reason ? undefined : "Pick a reason first"}
          />
          {!reason ? (
            <Text variant="caption" color="subtle" style={styles.centered}>
              Pick a reason to cancel.
            </Text>
          ) : null}
        </View>
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
  content: { paddingHorizontal: spacing.xl, paddingBottom: spacing["2xl"], gap: spacing.lg },
  offer: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.primary[200],
    backgroundColor: colors.primary[50],
  },
  offerText: { flex: 1, gap: 2 },
  question: { marginBottom: -spacing.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  chipSelected: { borderColor: colors.primary[500], backgroundColor: colors.primary[50] },
  chipPressed: { opacity: 0.7 },
  chipTextSelected: { color: colors.primary[700], fontWeight: typography.weight.semibold },
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
  actions: { gap: spacing.md, marginTop: spacing.xs },
  centered: { textAlign: "center" },
});
