import { StyleSheet, Text, View } from "react-native";
import { brand, colors } from "@rida/mobile-shared";

/** Rounded-square "C" logomark — white tile with the brand-green letter, for use on green surfaces (splash, welcome). */
export function Logomark({ size = 72 }: { size?: number }) {
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: size * 0.28 },
      ]}
    >
      <Text style={[styles.letter, { fontSize: size * 0.5 }]}>C</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    color: brand.primary,
    fontWeight: "800",
  },
});
