import { ActivityIndicator, View, StyleSheet } from "react-native";
import { colors, spacing } from "../tokens";
import { Text } from "./Text";

export interface LoadingStateProps {
  message?: string;
}

/** Centered spinner with an optional message — used for full-screen loading. */
export function LoadingState({ message }: LoadingStateProps) {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.primary[500]} />
      {message ? (
        <Text variant="body" color="muted" style={styles.message}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  message: {
    marginTop: spacing.md,
    textAlign: "center",
  },
});
