/**
 * The phone's frame: an iPhone 15 (47pt status bar, 34pt home indicator)
 * unless run.mjs --device picked another size.
 */
import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";

type Device = { width: number; height: number; insets: { top: number; bottom: number } };
const DEVICE: Device = (globalThis as { __screensDevice?: Device }).__screensDevice ?? {
  width: 390,
  height: 844,
  insets: { top: 47, bottom: 34 },
};

export const INSETS = { ...DEVICE.insets, left: 0, right: 0 };
export const FRAME = { x: 0, y: 0, width: DEVICE.width, height: DEVICE.height };
export type Edge = "top" | "bottom" | "left" | "right";

export const initialWindowMetrics = { insets: INSETS, frame: FRAME };
export const useSafeAreaInsets = () => INSETS;
export const useSafeAreaFrame = () => FRAME;
export const SafeAreaProvider = ({ children }: { children?: ReactNode }) => <>{children}</>;
export const SafeAreaInsetsContext = {
  Consumer: ({ children }: { children: (i: typeof INSETS) => ReactNode }) => children(INSETS),
};

export function SafeAreaView({
  edges = ["top", "bottom", "left", "right"],
  style,
  ...rest
}: ViewProps & { edges?: readonly Edge[] }) {
  const pad = {
    paddingTop: edges.includes("top") ? INSETS.top : 0,
    paddingBottom: edges.includes("bottom") ? INSETS.bottom : 0,
  };
  return <View style={[pad, style]} {...rest} />;
}
