import { useState } from "react";
import { View, TextInput, StyleSheet, type TextInputProps } from "react-native";
import { colors, radii, spacing, touchTarget, typography } from "../tokens";
import { Text } from "./Text";

export interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

/** Labeled text input with focus and error states. Used by auth and ride-request forms. */
export function Input({ label, error, style, onFocus, onBlur, ...rest }: InputProps) {
  const [isFocused, setIsFocused] = useState(false);

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
});
