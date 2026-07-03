import { useEffect, useState } from "react";
import { StyleSheet, Text as RNText, View } from "react-native";
import { Image } from "expo-image";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { colors, typography } from "../tokens";
import { cloudinaryAvatar } from "../../config/cloudinary";

export interface AvatarProps {
  /** Photo URL (Cloudinary URLs get a right-sized face-crop rendition). Null/undefined or load failure falls back to initials. */
  uri?: string | null;
  /** Full name — up to two initials are derived for the fallback. */
  name: string;
  /** Diameter in points. Defaults to 56. */
  size?: number;
}

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();
}

/** Opacity-pulsing placeholder circle shown while the photo loads. */
function Shimmer() {
  const pulse = useSharedValue(0.5);

  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
    return () => cancelAnimation(pulse);
  }, [pulse]);

  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return <Animated.View style={[StyleSheet.absoluteFill, styles.shimmer, style]} />;
}

/**
 * Image-first avatar: shimmer skeleton while loading → photo fade-in; on a
 * missing URL or load error, initials on the brand tint. The photo is the
 * default, initials are strictly the fallback.
 */
export function Avatar({ uri, name, size = 56 }: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const showImage = !!uri && !failed;
  const circle = { width: size, height: size, borderRadius: size / 2 };

  return (
    <View style={[styles.container, circle]} accessibilityLabel={name}>
      {showImage ? (
        <>
          {!loaded && <Shimmer />}
          <Image
            source={{ uri: cloudinaryAvatar(uri, size) }}
            style={circle}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={200}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </>
      ) : (
        <RNText
          style={[styles.initials, { fontSize: size * 0.36, lineHeight: size }]}
          numberOfLines={1}
        >
          {initialsOf(name)}
        </RNText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.primary[50],
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  shimmer: {
    backgroundColor: colors.surfaceSunken,
  },
  initials: {
    color: colors.primary[500],
    fontWeight: typography.weight.bold,
    textAlign: "center",
  },
});
