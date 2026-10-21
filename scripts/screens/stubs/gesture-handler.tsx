/**
 * No real gestures in a screenshot: views pass through and the builders
 * accept anything — except that a long-press's `onStart` is remembered, and
 * clicking inside its GestureDetector runs it. That's how a scene "slides"
 * a SlideToConfirm (it confirms on a long-press too): press its label.
 */
import type { ReactNode } from "react";
import { View } from "react-native";

export const GestureHandlerRootView = View;

interface Built {
  kind: string;
  handlers: Record<string, (...args: unknown[]) => void>;
  gestures?: Built[];
}

/** Gesture.Pan().onUpdate(…).onEnd(…): every call returns the same builder, keeping `on…` callbacks. */
function builder(kind: string): Built {
  const built: Built = { kind, handlers: {} };
  const proxy: Built = new Proxy(built, {
    get(target, prop) {
      if (prop === "kind" || prop === "handlers" || prop === "gestures") return target[prop];
      return (...args: unknown[]) => {
        if (typeof prop === "string" && prop.startsWith("on") && typeof args[0] === "function") {
          target.handlers[prop] = args[0] as (...a: unknown[]) => void;
        }
        return proxy;
      };
    },
  });
  return proxy;
}

const COMPOSITES = new Set(["Race", "Simultaneous", "Exclusive"]);
export const Gesture = new Proxy(
  {},
  {
    get: (_target, name: string) =>
      COMPOSITES.has(name)
        ? (...gestures: Built[]) => ({ kind: name, handlers: {}, gestures })
        : () => builder(name),
  },
);

function longPressOf(gesture: Built | undefined): Built | undefined {
  if (!gesture) return undefined;
  if (gesture.kind === "LongPress") return gesture;
  for (const g of gesture.gestures ?? []) {
    const found = longPressOf(g);
    if (found) return found;
  }
  return undefined;
}

export const GestureDetector = ({
  gesture,
  children,
}: {
  gesture?: Built;
  children: ReactNode;
}) => {
  const longPress = longPressOf(gesture);
  if (!longPress) return <>{children}</>;
  const props = { onClick: () => longPress.handlers.onStart?.() } as object;
  return <View {...props}>{children}</View>;
};
