import { act, renderHook } from "@testing-library/react-native";
import { SplashScreen } from "expo-router";
import { fonts, useAppFonts } from "../design/fonts";

/**
 * The splash screen waits for Figtree, but a font that fails or hangs never
 * keeps the app from opening.
 */

let mockFontState: [boolean, Error | null] = [false, null];
const mockUseFonts = jest.fn((_map: Record<string, number>) => mockFontState);

jest.mock("expo-font", () => ({
  useFonts: (map: Record<string, number>) => mockUseFonts(map),
}));

jest.mock("expo-router", () => ({
  SplashScreen: { hideAsync: jest.fn(async () => {}), preventAutoHideAsync: jest.fn(async () => {}) },
}));

const hideAsync = SplashScreen.hideAsync as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  mockFontState = [false, null];
  mockUseFonts.mockClear();
  hideAsync.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

it("loads one file per exported weight, under the exported names", async () => {
  await renderHook(() => useAppFonts());
  const loaded = Object.keys(mockUseFonts.mock.calls[0][0]).sort();
  expect(loaded).toEqual(Object.values(fonts).sort());
});

it("keeps the splash up while loading, then hides it once the fonts are in", async () => {
  const { result, rerender } = await renderHook(() => useAppFonts());
  expect(result.current).toBe(false);
  expect(hideAsync).not.toHaveBeenCalled();

  mockFontState = [true, null];
  await rerender({});
  expect(result.current).toBe(true);
  expect(hideAsync).toHaveBeenCalledTimes(1);
});

it("opens on the system font when loading fails", async () => {
  const { result, rerender } = await renderHook(() => useAppFonts());
  mockFontState = [false, new Error("font file missing")];
  await rerender({});
  expect(result.current).toBe(true);
  expect(hideAsync).toHaveBeenCalledTimes(1);
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
  expect(hideAsync).toHaveBeenCalledTimes(1);
});
