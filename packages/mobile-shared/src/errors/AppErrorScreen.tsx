import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { hideSplashScreen } from "../design/splash";
import { colors, spacing } from "../design/tokens";
import { reportError } from "../monitoring";

export interface AppErrorScreenProps {
  error: Error;
  /** expo-router's retry: renders the screen again. */
  retry: () => Promise<void> | void;
  /** Where it was caught, for the error report ("driver-root", "driver-trip"). */
  where: string;
  /** A second way out, e.g. "Go to Home" from the trip screen. */
  secondary?: { label: string; onPress: () => void };
}

/**
 * What a screen shows instead of going blank when it throws: export it as
 * that route's (or the root layout's) `ErrorBoundary` (expo-router). Plain
 * words and a retry, never the error itself. Needs no provider, so it works
 * in place of the root layout too, and it takes down the splash screen, so
 * the app never sits on a white or green screen.
 *
 * Only JavaScript errors reach it: a native crash ends the app (the map's
 * launch guard, maps/mapSafety.ts, covers the known one).
 */
export function AppErrorScreen({ error, retry, where, secondary }: AppErrorScreenProps) {
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    reportError(error, where);
  }, [error, where]);

  return (
    <View style={styles.root} onLayout={hideSplashScreen} testID="app-error-screen">
      <Text variant="title2" accessibilityRole="header" style={styles.center}>
        Something went wrong
      </Text>
      <Text variant="body" color="secondary" style={styles.center}>
        This screen hit a problem. Try again; if it keeps happening, close the app and open it again.
      </Text>
      <View style={styles.actions}>
        <Button
          label="Try again"
          loading={retrying}
          onPress={async () => {
            setRetrying(true);
            try {
              await retry();
            } finally {
              setRetrying(false);
            }
          }}
        />
        {secondary ? <Button label={secondary.label} variant="secondary" onPress={secondary.onPress} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    gap: spacing[3],
    paddingHorizontal: spacing.gutter,
    backgroundColor: colors.surface,
  },
  center: { textAlign: "center" },
  actions: { gap: spacing[3], marginTop: spacing[3] },
});
