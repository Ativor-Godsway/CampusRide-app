import { useId, useState } from "react";
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  View,
  TextInput,
  StyleSheet,
  type TextInputProps,
} from "react-native";
import { colors, radii, spacing, touchTarget, typography } from "../tokens";
import { Text } from "./Text";

export interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  /**
   * Adds a "Done" affordance above the keyboard — required for numeric
   * keypads (phone-pad / number-pad), which have no return key of their own.
   * On iOS this renders an `InputAccessoryView` bar; on Android it sets
   * `returnKeyType="done"` so the keypad's own done/checkmark dismisses it.
   */
  doneAccessory?: boolean;
}

/** Labeled text input with focus and error states. Used by auth and ride-request forms. */
export function Input({ label, error, style, onFocus, onBlur, doneAccessory, ...rest }: InputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const accessoryId = useId();
  const showIosAccessory = doneAccessory && Platform.OS === "ios";

  return (
    <View style={styles.container}>
      {label ? (
        <Text variant="label" color="muted" style={styles.label}>
          {label}
        </Text>
      ) : null}
      <TextInput
        style={[
          styles.input,
          isFocused && styles.inputFocused,
          error ? styles.inputError : null,
          style,
        ]}
        placeholderTextColor={colors.ink[300]}
        returnKeyType={doneAccessory ? "done" : rest.returnKeyType}
        onSubmitEditing={(e) => {
          if (doneAccessory && !rest.onSubmitEditing) {
            Keyboard.dismiss();
          }
          rest.onSubmitEditing?.(e);
        }}
        inputAccessoryViewID={showIosAccessory ? accessoryId : undefined}
        onFocus={(e) => {
          setIsFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          onBlur?.(e);
        }}
        {...rest}
      />
      {error ? (
        <Text variant="bodySmall" color="error" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {showIosAccessory ? (
        <InputAccessoryView nativeID={accessoryId}>
          <View style={styles.accessoryBar}>
            <Pressable onPress={Keyboard.dismiss} accessibilityRole="button">
              <Text variant="bodyMedium" color="primary" style={styles.accessoryDone}>
                Done
              </Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.xs,
  },
  input: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    minHeight: touchTarget.minHeight,
    fontSize: typography.size.md,
    color: colors.ink[900],
    backgroundColor: colors.white,
  },
  inputFocused: {
    borderColor: colors.primary[400],
    backgroundColor: colors.white,
  },
  inputError: {
    borderColor: colors.error,
  },
  error: {
    marginTop: spacing.xs,
  },
  accessoryBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  accessoryDone: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    fontWeight: typography.weight.semibold,
  },
});
