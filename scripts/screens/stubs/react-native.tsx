/**
 * react-native for the screenshots: react-native-web, plus what it lacks,
 * and Platform reporting iOS so the screens take their iPhone branches.
 */
import * as RNW from "react-native-web";

export * from "react-native-web";

export const Platform = {
  ...RNW.Platform,
  OS: "ios" as const,
  Version: "18.0",
  isPad: false,
  isTV: false,
  select: <T,>(options: { ios?: T; native?: T; default?: T }) =>
    options.ios ?? options.native ?? options.default,
};

/** Android's back button: there is none on the web. */
export const BackHandler = {
  addEventListener: () => ({ remove: () => undefined }),
  exitApp: () => undefined,
};

/** iOS's bar above the keyboard: there's no keyboard in a screenshot. */
export const InputAccessoryView = () => null;

type Source = { uri?: string; width?: number; height?: number } | number | string | undefined;

// The apps size their art from the PNG's own pixels (see build.mjs).
const Image = RNW.Image as typeof RNW.Image & { resolveAssetSource?: (s: Source) => unknown };
Image.resolveAssetSource = (source: Source) =>
  typeof source === "object" && source
    ? source
    : typeof source === "string"
      ? { uri: source }
      : null;
export { Image };

type SwitchProps = Parameters<typeof RNW.Switch>[0] & { thumbColor?: string };

/** react-native-web takes the "on" thumb colour as activeThumbColor; the apps pass thumbColor. */
export function Switch({ thumbColor, ...rest }: SwitchProps) {
  return <RNW.Switch {...rest} thumbColor={thumbColor} activeThumbColor={thumbColor} />;
}

export const ToastAndroid = { show: () => undefined, SHORT: 0, LONG: 1 };
export const DevSettings = { addMenuItem: () => undefined, reload: () => undefined };
export const TurboModuleRegistry = { get: () => null, getEnforcing: () => null };
export const requireNativeComponent = () => () => null;
