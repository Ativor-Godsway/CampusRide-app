import { ActivityIndicator, Image, View, StyleSheet } from "react-native";
import { illustrations } from "../illustrations";
import { colors, spacing } from "../tokens";
import { Text } from "./Text";

export interface LoadingStateProps {
  message?: string;
  /** The logo mark above the spinner: for a whole-app loading screen. */
  logo?: boolean;
}

/** Centered spinner with an optional message, on the white page. */
export function LoadingState({ message, logo = false }: LoadingStateProps) {
  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={message ?? "Loading"}
    >
      {logo ? (
        <Image source={illustrations.logoMark} style={styles.logo} resizeMode="contain" />
      ) : null}
      <ActivityIndicator size={logo ? "small" : "large"} color={colors.green500} />
      {message ? (
        <Text variant="body" color="secondary" style={styles.message}>
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
    backgroundColor: colors.surface,
  },
  logo: {
    width: 72,
    height: 72,
    marginBottom: spacing[6],
  },
  message: {
    marginTop: spacing[3],
    textAlign: "center",
  },
});
