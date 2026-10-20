/** An iPhone 15-ish frame: 47pt status bar, 34pt home indicator. */
import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";

export const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };
const FRAME = { x: 0, y: 0, width: 390, height: 844 };
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
