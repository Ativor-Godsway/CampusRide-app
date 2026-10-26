/**
 * Runs before every test file: stands in for the phone's keychain, so the
 * real auth code can store and read its refresh token.
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK: 0,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    __store: store,
  };
});

// Native map views don't exist outside a phone; nothing under test draws a map.
jest.mock("react-native-maps", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    default: View,
    Marker: View,
    Polyline: View,
    Circle: View,
    PROVIDER_DEFAULT: undefined,
    PROVIDER_GOOGLE: "google",
  };
});

// Lottie draws natively; in tests the welcome animation is an empty view.
jest.mock("lottie-react-native", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return { __esModule: true, default: View };
});

// Crash reporting is off in tests; the real module starts a timer on import
// that would keep jest from exiting.
jest.mock("@sentry/react-native", () => ({
  init: jest.fn(),
  setTags: jest.fn(),
  wrap: <T>(component: T) => component,
}));

// Reanimated and gesture-handler drive the bottom sheet, the pulse and the
// slider natively; their own jest stand-ins run them in plain JS.
/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories and gesture-handler's documented setup */
jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
require("react-native-gesture-handler/jestSetup");
/* eslint-enable @typescript-eslint/no-require-imports */
