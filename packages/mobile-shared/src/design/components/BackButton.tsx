import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { IconButton } from "./IconButton";

/**
 * The 44px round Back at the top of a pushed screen (Profile, Safety, …):
 * the screens have no navigation header. Goes back, or home when there is
 * nothing to go back to (the screen was opened from a link).
 */
export function BackButton({
  onPress,
  style,
}: {
  /** Instead of going back (e.g. "Not now" on the notifications screen). */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const router = useRouter();
  return (
    <View style={[styles.back, style]}>
      <IconButton
        variant="compact"
        icon="arrow-back"
        accessibilityLabel="Back"
        onPress={onPress ?? (() => (router.canGoBack() ? router.back() : router.replace("/")))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: "flex-start" },
});
