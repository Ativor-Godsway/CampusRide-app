/** Ionicons from its own font and glyph map (the font is loaded by index.html). */
import { Text, type StyleProp, type TextStyle } from "react-native";
import glyphMap from "@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json";

type Props = { name: string; size?: number; color?: string; style?: StyleProp<TextStyle> };

export function Ionicons({ name, size = 24, color = "#000", style }: Props) {
  const code = (glyphMap as Record<string, number>)[name];
  return (
    <Text
      selectable={false}
      style={[
        {
          fontFamily: "Ionicons",
          fontSize: size,
          lineHeight: size,
          color,
          fontWeight: "normal",
          fontStyle: "normal",
        },
        style,
      ]}
    >
      {code ? String.fromCodePoint(code) : "?"}
    </Text>
  );
}
Ionicons.glyphMap = glyphMap as Record<string, number>;
