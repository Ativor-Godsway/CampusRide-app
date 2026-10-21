import { act, renderHook } from "@testing-library/react-native";
import * as SplashScreen from "expo-splash-screen";
import { SPLASH_FALLBACK_MS, fonts, useAppFonts } from "../design/fonts";

/**
 * The splash screen waits for Figtree, but a font that fails or hangs never
 * keeps the app from opening. Hiding it is the root view's job (onLayout);
 * useAppFonts only steps in if that never happens.
 */

let mockFontState: [boolean, Error | null] = [false, null];
const mockUseFonts = jest.fn((_map: Record<string, number>) => mockFontState);

jest.mock("expo-font", () => ({
  useFonts: (map: Record<string, number>) => mockUseFonts(map),
}));

jest.mock("expo-splash-screen", () => ({
  hide: jest.fn(),
  preventAutoHideAsync: jest.fn(async () => true),
  setOptions: jest.fn(),
}));

const hide = SplashScreen.hide as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  mockFontState = [false, null];
  mockUseFonts.mockClear();
  hide.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

it("loads one file per exported weight, under the exported names", async () => {
  await renderHook(() => useAppFonts());
  const loaded = Object.keys(mockUseFonts.mock.calls[0][0]).sort();
  expect(loaded).toEqual(Object.values(fonts).sort());
});

it("is not ready while loading, then ready once the fonts are in", async () => {
  const { result, rerender } = await renderHook(() => useAppFonts());
  expect(result.current).toBe(false);

  mockFontState = [true, null];
  await rerender({});
  expect(result.current).toBe(true);
});

it("leaves the splash to the root view's layout, hiding it itself only as a fallback", async () => {
  mockFontState = [true, null];
  await renderHook(() => useAppFonts());
  await act(async () => {
    jest.advanceTimersByTime(SPLASH_FALLBACK_MS - 1);
  });
  expect(hide).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(hide).toHaveBeenCalledTimes(1);
});

it("never hides the splash before the app may render", async () => {
  await renderHook(() => useAppFonts());
  await act(async () => {
    jest.advanceTimersByTime(3999);
  });
  expect(hide).not.toHaveBeenCalled();
});

it("opens on the system font when loading fails", async () => {
  const { result, rerender } = await renderHook(() => useAppFonts());
  mockFontState = [false, new Error("font file missing")];
  await rerender({});
  expect(result.current).toBe(true);
});

it("opens anyway if loading never finishes", async () => {
  const { result } = await renderHook(() => useAppFonts());
  await act(async () => {
    jest.advanceTimersByTime(3999);
  });
  expect(result.current).toBe(false);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(result.current).toBe(true);
});
