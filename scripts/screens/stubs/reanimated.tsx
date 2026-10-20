/**
 * react-native-reanimated for still screenshots: shared values hold plain
 * values, animations jump to their end, animated views are plain views.
 * (Its worklet runtime doesn't start on react-native-web in this bundle.)
 */
import { useRef } from "react";
import { Image, ScrollView, Text, View } from "react-native";

const identity = (t: number) => t;
const easingFn = () => identity;
export const Easing = {
  linear: identity,
  ease: identity,
  quad: identity,
  cubic: identity,
  exp: identity,
  sin: identity,
  circle: identity,
  bounce: identity,
  poly: easingFn,
  elastic: easingFn,
  back: easingFn,
  bezier: () => identity,
  in: easingFn,
  out: easingFn,
  inOut: easingFn,
};

export function useSharedValue<T>(initial: T) {
  return useRef({ value: initial }).current;
}
export const useDerivedValue = <T,>(fn: () => T) => ({ value: fn() });
export const useAnimatedStyle = <T,>(fn: () => T) => fn();
export const useAnimatedProps = <T,>(fn: () => T) => fn();
export const useReducedMotion = () => true;
export const withTiming = <T,>(to: T) => to;
export const withSpring = <T,>(to: T) => to;
export const withDecay = () => 0;
export const withDelay = <T,>(_ms: number, animation: T) => animation;
export const withRepeat = <T,>(animation: T) => animation;
export const withSequence = <T,>(...animations: T[]) => animations[animations.length - 1];
export const cancelAnimation = () => undefined;
export const runOnJS =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  (...args: A) =>
    fn(...args);
export const runOnUI = runOnJS;
export function interpolate(x: number, input: number[], output: number[]) {
  const [i0, i1] = [input[0], input[input.length - 1]];
  const [o0, o1] = [output[0], output[output.length - 1]];
  const t = i1 === i0 ? 0 : Math.min(1, Math.max(0, (x - i0) / (i1 - i0)));
  return o0 + (o1 - o0) * t;
}
export const Extrapolation = { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" };

const Animated = {
  View,
  Text,
  Image,
  ScrollView,
  createAnimatedComponent: <T,>(component: T) => component,
};
export default Animated;
