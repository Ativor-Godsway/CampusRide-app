/** No gestures in a screenshot: views pass through, gesture builders accept anything. */
import type { ReactNode } from "react";
import { View } from "react-native";

export const GestureHandlerRootView = View;
export const GestureDetector = ({ children }: { children: ReactNode }) => <>{children}</>;

/** Gesture.Pan().onUpdate(…).onEnd(…): every call returns the same builder. */
const builder: object = new Proxy(() => builder, { get: () => () => builder });
export const Gesture = new Proxy({}, { get: () => () => builder });
