/**
 * CampusRide design tokens — single source of truth for both the rider and
 * driver apps. Brand direction: clean, modern, trustworthy (it handles
 * money) — a deep green primary against near-black text and warm-white
 * surfaces, restrained use of color for state (success/error/warning) and
 * the "Soon" treatment on upcoming services.
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
  ink: {
    900: "#111111",
    800: "#1F2422",
    600: "#3F4845",
    400: "#6B7572",
    200: "#A8B0AD",
    100: "#D6DCDA",
    50: "#EEF2F0",
  },
  white: "#FFFFFF",
  background: "#FFFFFF",
  surface: "#F5F7F6",
  surfaceMuted: "#ECEFED",
  border: "#E1E6E3",
  success: "#1A7A3C",
  successSurface: "#E8F5ED",
  error: "#C53030",
  errorSurface: "#FBEAEA",
  warning: "#B7791F",
  warningSurface: "#FBF3E1",
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
  },
  weight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  } as const,
  lineHeight: {
    tight: 1.15,
    normal: 1.4,
    relaxed: 1.6,
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
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
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
} as const;

/** Minimum hit target (iOS HIG / Material guidance) for tappable elements. */
export const touchTarget = {
  minHeight: 48,
} as const;
