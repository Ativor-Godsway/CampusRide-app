import { Image, View, StyleSheet, type ImageSourcePropType } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii } from "../tokens";

export interface ServiceIconProps {
  name: keyof typeof Ionicons.glyphMap;
  color?: string;
  background?: string;
  /** Outer container size (square). */
  size?: number;
  iconSize?: number;
  /**
   * Illustration slot: pass a real PNG/SVG asset (e.g. `require("./car.png")`)
   * to render in place of the icon once 3D art is available — the tile layout
   * and sizing stay unchanged, only this prop needs to be set.
   */
  source?: ImageSourcePropType;
}

/**
 * Service-tile illustration slot. Renders an Ionicons glyph in a tinted
 * rounded container today; pass `source` to swap in real illustration art
 * later without changing any layout that uses this component.
 */
export function ServiceIcon({
  name,
  color = colors.primary[600],
  background = colors.primary[50],
  size = 56,
  iconSize,
  source,
}: ServiceIconProps) {
  if (source) {
    return <Image source={source} style={{ width: size, height: size, borderRadius: radii.lg }} resizeMode="contain" />;
  }

  return (
    <View style={[styles.container, { width: size, height: size, backgroundColor: background }]}>
      <Ionicons name={name} size={iconSize ?? Math.round(size * 0.5)} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radii.lg,
    alignItems: "center",
    justifyContent: "center",
  },
});
