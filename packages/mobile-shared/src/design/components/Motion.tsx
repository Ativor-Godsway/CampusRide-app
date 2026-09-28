import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useReduceMotion } from "./Illustration";

export interface PressableScaleProps extends Omit<PressableProps, "style" | "children"> {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Scale while pressed. Subtle by default. */
  pressedScale?: number;
}

/**
 * A Pressable that dips slightly while pressed — the tactile "give" of a
 * premium card. Native-driver animation; no scaling with Reduce Motion on
 * (a small opacity dip still confirms the touch).
 */
export function PressableScale({
  children,
  style,
  pressedScale = 0.98,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps) {
  const reduceMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const animateTo = (pressed: boolean) => {
    if (reduceMotion) {
      opacity.setValue(pressed ? 0.85 : 1);
      return;
    }
    Animated.spring(scale, {
      toValue: pressed ? pressedScale : 1,
      speed: 40,
      bounciness: pressed ? 0 : 6,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        animateTo(true);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        animateTo(false);
        onPressOut?.(e);
      }}
    >
      <Animated.View style={[style, { opacity, transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

export interface FadeInProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Start delay in ms, for gentle staggering. */
  delay?: number;
}

/**
 * Fades and lifts its children in on mount — used when the ride sheet moves
 * between states (searching → driver found) so the change reads as one
 * smooth step rather than a jump. Appears instantly with Reduce Motion on.
 */
export function FadeIn({ children, style, delay = 0 }: FadeInProps) {
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 320,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, delay, reduceMotion]);

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });
  return (
    <Animated.View style={[style, { opacity: progress, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}
