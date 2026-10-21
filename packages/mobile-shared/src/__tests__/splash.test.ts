import * as SplashScreen from "expo-splash-screen";
import { SPLASH_FADE_MS, hideSplashScreen, holdSplashScreen } from "../design/splash";

/** The root layout holds the native splash, then hides it once laid out. */

jest.mock("expo-splash-screen", () => ({
  hide: jest.fn(),
  preventAutoHideAsync: jest.fn(async () => true),
  setOptions: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

it("keeps the splash up, set to fade into the first screen", () => {
  holdSplashScreen();
  expect(SplashScreen.preventAutoHideAsync).toHaveBeenCalledTimes(1);
  expect(SplashScreen.setOptions).toHaveBeenCalledWith({ fade: true, duration: SPLASH_FADE_MS });
});

it("hides it when asked", () => {
  hideSplashScreen();
  expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
});
