import { StyleSheet, View } from "react-native";
import { colors, radii, spacing } from "../tokens";

/** Standard grab handle for bottom sheets — 34×4 rounded bar, centered. */
export function SheetHandle() {
  return <View style={styles.handle} />;
}

const styles = StyleSheet.create({
  handle: {
    width: 34,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.borderStrong,
    alignSelf: "center",
    marginVertical: spacing.sm,
  },
});
