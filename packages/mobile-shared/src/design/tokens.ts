/**
 * CampusRide design tokens — single source of truth for both the rider and
 * driver apps. Brand direction: Bolt/Uber-caliber — calm, confident,
 * high-contrast, trustworthy (it handles money). The CampusRide forest green
 * (#19743C) is the brand anchor; a warm amber accent provides contrast for
 * highlights (ratings, live indicators), near-black ink carries text, and
 * warm-neutral surfaces keep the UI calm without feeling sterile.
 */

import { Platform } from "react-native";

export const colors = {
  primary: {
    50: "#E8F3EC",
    100: "#CDE6D6",
    200: "#9BD5AE",
    300: "#6CC089",
    400: "#3F9F63",
    500: "#19743C",
    600: "#115C2F",
    700: "#0F5429",
    800: "#0D3B1D",
    900: "#082813",
  },
  /** Warm amber accent — used sparingly for highlights, ratings, and live/active indicators. */
  accent: {
    50: "#FBF0DA",
    100: "#F0DFBE",
    200: "#FFDA85",
    300: "#FFC94D",
    400: "#FFBB29",
    500: "#E0902A",
    600: "#9A6711",
    700: "#7A5310",
  },
  ink: {
    900: "#0F1311",
    800: "#1F2422",
    700: "#2B3230",
    600: "#3F4845",
    500: "#545D5A",
    400: "#6B7280",
    300: "#9AA1A6",
    200: "#A8B0AD",
    100: "#D6DCDA",
    50: "#EEF2F0",
  },
  white: "#FFFFFF",
  background: "#F1F3F2",
  surface: "#F6F7F6",
  surfaceMuted: "#ECEFED",
  surfaceSunken: "#E4E9E6",
  hairline: "#F0F2F0",
  border: "#E8EBE9",
  borderStrong: "#CBD3CF",
  /** Deep near-black surface for selective "feature card" emphasis (Uber-style account tiles, signature dark hero cards). Use sparingly. */
  surfaceDark: "#0F1311",
  surfaceDarkElevated: "#14181A",
  borderDark: "#2E362F",
  /** Accent text/dots on dark surfaces (e.g. "Live" pulse, online status, dark-card highlights). */
  glowGreen: "#7BE0A0",
  success: "#19743C",
  successSurface: "#E8F3EC",
  error: "#B23A3A",
  errorSurface: "#FBEAEA",
  danger: "#B23A3A",
  warning: "#9A6711",
  warningSurface: "#FBF0DA",
  /** Translucent scrim for sheets/modals. */
  overlay: "rgba(8, 40, 19, 0.45)",
} as const;

export const typography = {
  fontFamily: {
    base: undefined, // system default — keeps native feel on both platforms
    /** System monospace — for plates, OTP/codes, timers, and fares-as-figures only. */
    mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  size: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 20,
    "2xl": 24,
    "3xl": 30,
    "4xl": 36,
    "5xl": 44,
  },
  weight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
    extrabold: "800",
  } as const,
  lineHeight: {
    tight: 1.15,
    normal: 1.4,
    relaxed: 1.6,
  },
  /** Negative tracking on large headings reads as more confident/designed. */
  letterSpacing: {
    tight: -0.5,
    tighter: -1,
    normal: 0,
    wide: 0.5,
    wider: 1,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 40,
  "4xl": 56,
  "5xl": 72,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  "2xl": 32,
  full: 999,
} as const;

export const shadows = {
  sm: {
    shadowColor: colors.ink[900],
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  md: {
    shadowColor: colors.ink[900],
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  lg: {
    shadowColor: colors.ink[900],
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 8,
  },
  /** Brand-tinted glow for primary CTAs — green-tinted lift instead of a flat ink shadow. */
  brand: {
    shadowColor: colors.primary[500],
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 6,
  },
} as const;

/** Shared animation durations (ms) for Animated-based transitions (sheets, progress bars, etc). */
export const motion = {
  duration: {
    fast: 120,
    normal: 220,
    slow: 360,
  },
} as const;

/** Minimum hit target (iOS HIG / Material guidance) for tappable elements. */
export const touchTarget = {
  minHeight: 48,
} as const;
