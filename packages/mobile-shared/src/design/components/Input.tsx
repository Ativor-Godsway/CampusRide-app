import { View, TextInput, StyleSheet, type TextInputProps } from "react-native";
import { colors, radii, spacing, touchTarget, typography } from "../tokens";
import { Text } from "./Text";

export interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

/** Labeled text input with an error state. Used by auth and ride-request forms. */
export function Input({ label, error, style, ...rest }: InputProps) {
  return (
    <View style={styles.container}>
      {label ? (
        <Text variant="label" color="muted" style={styles.label}>
          {label}
        </Text>
      ) : null}
      <TextInput
        style={[styles.input, error ? styles.inputError : null, style]}
        placeholderTextColor={colors.ink[200]}
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
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    minHeight: touchTarget.minHeight,
    fontSize: typography.size.md,
    color: colors.ink[900],
    backgroundColor: colors.white,
  },
  inputError: {
    borderColor: colors.error,
  },
  error: {
    marginTop: spacing.xs,
  },
});
