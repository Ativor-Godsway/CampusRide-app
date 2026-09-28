import { StyleSheet, View } from "react-native";
import { Button, Illustration, Text, colors, spacing } from "@rida/mobile-shared";

/**
 * The dispatch window ran out with no driver (AWAITING_RIDER_DECISION).
 *
 * no-drivers.png has an OPAQUE #FFFFFF background, so this panel must sit on
 * pure white: it renders straight onto the ride sheet (colors.white,
 * #FFFFFF), never inside a tinted card, and sets that white itself too in
 * case it is ever moved.
 */
export function NoDriversPanel({
  switchOffer,
  busy,
  onSearchAgain,
  onSwitch,
  onCancel,
}: {
  /** e.g. "Switch to Ride alone · GHS 15"; null when a switch isn't possible. */
  switchOffer: string | null;
  busy: "search" | "switch" | null;
  onSearchAgain: () => void;
  onSwitch: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.hero}>
        {/* No `float`: its drop shadow sits partly under the art, and this
            image's opaque white box would clip it into a hard edge. */}
        <Illustration name="noDrivers" size={150} />
      </View>

      <View style={styles.heading} accessibilityLiveRegion="polite">
        <Text variant="h2" style={styles.centered} accessibilityRole="header">
          No drivers available right now
        </Text>
        <Text variant="bodySmall" color="muted" style={styles.centered}>
          Campus availability changes quickly — searching again often finds someone.
        </Text>
      </View>

      <View style={styles.actions}>
        <Button
          label="Search again"
          size="lg"
          onPress={onSearchAgain}
          loading={busy === "search"}
          disabled={busy !== null}
        />
        {switchOffer ? (
          <Button
            label={switchOffer}
            variant="secondary"
            onPress={onSwitch}
            loading={busy === "switch"}
            disabled={busy !== null}
          />
        ) : null}
        <Button label="Cancel ride" variant="ghost" onPress={onCancel} disabled={busy !== null} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Pure white on purpose — see the component comment.
  section: { gap: spacing.lg, backgroundColor: colors.white },
  hero: { alignItems: "center", backgroundColor: colors.white },
  heading: { gap: spacing.xs, paddingHorizontal: spacing.sm },
  centered: { textAlign: "center" },
  actions: { gap: spacing.md },
});
