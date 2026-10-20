import { useId, useState, type ComponentType, type ReactNode } from "react";
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  View,
  TextInput,
  StyleSheet,
  type TextInputProps,
  type TextStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fonts } from "../fonts";
import { colors, radii, sizes, spacing } from "../tokens";
import { Text, resolveFigtree } from "./Text";

export interface InputProps extends TextInputProps {
  /** Above the field (never placeholder-as-label). */
  label?: string;
  /** Under the field with an alert icon; say how to fix it. */
  error?: string;
  /** Hint under the field when there's no error. */
  helper?: string;
  /** Fixed content at the start of the field (e.g. the phone prefix). */
  prefix?: ReactNode;
  /**
   * Adds a "Done" affordance above the keyboard — required for numeric
   * keypads (phone-pad / number-pad), which have no return key of their own.
   * On iOS this renders an `InputAccessoryView` bar; on Android it sets
   * `returnKeyType="done"` so the keypad's own done/checkmark dismisses it.
   */
  doneAccessory?: boolean;
  /**
   * The underlying text-input component. Defaults to React Native's
   * `TextInput`. Pass a drop-in that accepts `TextInputProps` (e.g. gorhom's
   * `BottomSheetTextInput`) when the field lives inside a bottom sheet and
   * needs keyboard-aware resizing.
   */
  InputComponent?: ComponentType<TextInputProps>;
}

/**
 * Filled text field (docs/design-system.md, "Input"): surface-2 at rest,
 * white with a 2px green border when focused, a red border and message on
 * error. 56 tall, radius 14, value 17/600.
 */
export function Input({
  label,
  error,
  helper,
  prefix,
  style,
  onFocus,
  onBlur,
  doneAccessory,
  InputComponent = TextInput,
  accessibilityLabel,
  ...rest
}: InputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const accessoryId = useId();
  const showIosAccessory = doneAccessory && Platform.OS === "ios";
  const inputStyle = resolveFigtree(
    StyleSheet.flatten([styles.input, rest.multiline && styles.multiline, style]) as TextStyle,
  );

  return (
    <View style={styles.container}>
      {label ? (
        <Text variant="label" color="secondary" style={styles.label}>
          {label}
        </Text>
      ) : null}
      <View
        style={[styles.field, isFocused && styles.fieldFocused, error ? styles.fieldError : null]}
      >
        {prefix}
        <InputComponent
          style={inputStyle}
          placeholderTextColor={colors.ink3}
          accessibilityLabel={accessibilityLabel ?? label}
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
      </View>
      {error ? (
        <View style={styles.message} accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle" size={16} color={colors.red600} />
          <Text variant="subhead" color="danger" style={styles.messageText}>
            {error}
          </Text>
        </View>
      ) : helper ? (
        <Text variant="subhead" color="tertiary" style={styles.helper}>
          {helper}
        </Text>
      ) : null}
      {showIosAccessory ? (
        <InputAccessoryView nativeID={accessoryId}>
          <View style={styles.accessoryBar}>
            <Pressable onPress={Keyboard.dismiss} accessibilityRole="button">
              <Text variant="bodyStrong" color="brand" style={styles.accessoryDone}>
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
    marginBottom: spacing[4],
  },
  label: {
    marginBottom: spacing[2],
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: sizes.controlLg,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
    // Always 2px, transparent at rest, so focusing doesn't shift the text.
    borderWidth: 2,
    borderColor: "transparent",
    paddingHorizontal: spacing[4] - 2,
  },
  fieldFocused: {
    backgroundColor: colors.surface,
    borderColor: colors.green500,
  },
  fieldError: {
    borderColor: colors.red600,
  },
  input: {
    flex: 1,
    alignSelf: "stretch",
    fontFamily: fonts.semibold,
    fontSize: 17,
    color: colors.ink,
    paddingVertical: 0,
  },
  multiline: {
    paddingVertical: spacing[3],
    textAlignVertical: "top",
  },
  message: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing[1],
    marginTop: spacing[2],
  },
  messageText: {
    flex: 1,
  },
  helper: {
    marginTop: spacing[2],
  },
  accessoryBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    backgroundColor: colors.surface2,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  accessoryDone: {
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[2],
  },
});
