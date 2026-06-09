/**
 * CampusRide design tokens — single source of truth for both the rider and
 * driver apps. Brand direction: Bolt/Uber-caliber — calm, confident,
 * high-contrast, trustworthy (it handles money). The deep CampusRide green
 * (#1A7A3C) is the brand anchor; a warm amber accent provides contrast for
 * highlights (ratings, live indicators), near-black ink carries text, and
 * warm-neutral surfaces keep the UI calm without feeling sterile.
 */

export const colors = {
  primary: {
    50: "#E8F5ED",
    100: "#C8E8D3",
    200: "#9BD5AE",
    300: "#6CC089",
    400: "#3F9F63",
    500: "#1A7A3C",
    600: "#15642F",
    700: "#114F26",
    800: "#0D3B1D",
    900: "#082813",
  },
  /** Warm amber accent — used sparingly for highlights, ratings, and live/active indicators. */
  accent: {
    50: "#FFF6E0",
    100: "#FFE9B3",
    200: "#FFDA85",
    300: "#FFC94D",
    400: "#FFBB29",
    500: "#F5A623",
    600: "#D68910",
    700: "#A8690C",
  },
  ink: {
    900: "#111111",
    800: "#1F2422",
    700: "#2B3230",
    600: "#3F4845",
    500: "#545D5A",
    400: "#6B7572",
    300: "#8A938F",
    200: "#A8B0AD",
    100: "#D6DCDA",
    50: "#EEF2F0",
  },
  white: "#FFFFFF",
  background: "#F5F6F7",
  surface: "#F5F7F6",
  surfaceMuted: "#ECEFED",
  surfaceSunken: "#E4E9E6",
  border: "#E1E6E3",
  borderStrong: "#CBD3CF",
  /** Deep near-black surface for selective "feature card" emphasis (Uber-style account tiles). Use sparingly. */
  surfaceDark: "#10140F",
  surfaceDarkElevated: "#1B221C",
  borderDark: "#2E362F",
  success: "#1A7A3C",
  successSurface: "#E8F5ED",
  error: "#C53030",
  errorSurface: "#FBEAEA",
  warning: "#B7791F",
  warningSurface: "#FBF3E1",
  /** Translucent scrim for sheets/modals. */
  overlay: "rgba(8, 40, 19, 0.45)",
} as const;

export const typography = {
  fontFamily: {
    base: undefined, // system default — keeps native feel on both platforms
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
