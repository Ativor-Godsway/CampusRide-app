/**
 * CampusRide design tokens — single source of truth for both the rider and
 * driver apps. Brand direction: Uber-restraint × Bolt-warmth — soft warm-
 * neutral surfaces (cream/sand), deep forest green (#1A5E3A) as the single
 * accent, near-black ink text, generous whitespace, pill controls, soft
 * radii. Premium = restraint + motion; no decorative gradients or glows.
 *
 * Two layers:
 *  - `colors` — the raw scales (legacy names kept so existing screens in
 *    both apps keep compiling; values re-pointed to the warm palette).
 *  - `surface` / `brand` / `ink` / `border` / `status` / `rating` — the
 *    semantic layer. New/redesigned UI should use these.
 */

import { Platform } from "react-native";

export const colors = {
  primary: {
    50: "#E4EFE8",
    100: "#CBE2D4",
    200: "#9CC9AE",
    300: "#6FAE8B",
    400: "#3F8862",
    500: "#1A5E3A",
    600: "#134A2D",
    700: "#103F26",
    800: "#0C2F1D",
    900: "#082013",
  },
  /** Warm amber accent — ratings and live/active indicators only. */
  accent: {
    50: "#FBF3E4",
    100: "#F0DFBE",
    200: "#F2CE8B",
    300: "#EDBC61",
    400: "#E9B14E",
    500: "#E5A83B",
    600: "#B7791F",
    700: "#8F5E18",
  },
  ink: {
    900: "#171A17",
    800: "#22261F",
    700: "#343830",
    600: "#474C43",
    500: "#5B5F58",
    400: "#787C72",
    300: "#9A9D94",
    200: "#B4B6AD",
    100: "#D8D9D1",
    50: "#EDECE5",
  },
  white: "#FFFFFF",
  background: "#F0EEE8",
  surface: "#F4F2EC",
  surfaceMuted: "#EBE8E0",
  surfaceSunken: "#E7E4DC",
  hairline: "#EAE7DF",
  border: "#E3E0D8",
  borderStrong: "#CFCCC2",
  /** Deep near-black surface for selective "feature card" emphasis. Use sparingly. */
  surfaceDark: "#141613",
  surfaceDarkElevated: "#1C1F1A",
  borderDark: "#2E332C",
  /** Accent text/dots on dark surfaces (e.g. "Live" pulse, online status). */
  glowGreen: "#7BE0A0",
  success: "#1A5E3A",
  successSurface: "#E4EFE8",
  error: "#B3261E",
  errorSurface: "#F9E9E7",
  danger: "#B3261E",
  warning: "#B7791F",
  warningSurface: "#FBF3E4",
  /** Translucent scrim for sheets/modals. */
  overlay: "rgba(20, 22, 19, 0.35)",
} as const;

// ─── Semantic layer ───────────────────────────────────────────────────────────

export const surface = {
  base: colors.background,
  raised: colors.white,
  sunken: colors.surfaceSunken,
  inverse: colors.surfaceDark,
} as const;

export const brand = {
  primary: colors.primary[500],
  primaryPressed: colors.primary[600],
  /** Soft green fill for selected states and savings callouts. */
  tint: colors.primary[50],
} as const;

export const ink = {
  primary: colors.ink[900],
  secondary: colors.ink[500],
  tertiary: colors.ink[300],
  onBrand: colors.white,
} as const;

export const border = {
  subtle: colors.border,
  strong: colors.borderStrong,
} as const;

export const status = {
  success: colors.success,
  successTint: colors.successSurface,
  warning: colors.warning,
  warningTint: colors.warningSurface,
  error: colors.error,
  errorTint: colors.errorSurface,
} as const;

export const rating = {
  star: colors.accent[500],
} as const;

// ─── Type / space / shape ─────────────────────────────────────────────────────

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
    display: 34,
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
  /** Standard screen edge padding. */
  gutter: 20,
  xl: 24,
  "2xl": 32,
  "3xl": 40,
  "4xl": 56,
  "5xl": 72,
} as const;

export const radii = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  "2xl": 32,
  pill: 999,
  full: 999,
} as const;

/**
 * One soft ambient shadow language. Android elevation stays ≤ 4 everywhere —
 * stacked heavy elevations murder Android perf and read as un-designed.
 */
export const shadows = {
  sm: {
    shadowColor: colors.ink[900],
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  /** Raised cards. */
  md: {
    shadowColor: colors.ink[900],
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 3,
  },
  /** Floating surfaces (dock, sheets) — slightly stronger, still ambient. */
  lg: {
    shadowColor: colors.ink[900],
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 4,
  },
  /** @deprecated Green CTA glow retired with the redesign — kept as a soft ambient alias so existing callers keep compiling. */
  brand: {
    shadowColor: colors.ink[900],
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 3,
  },
} as const;

/**
 * Motion tokens. Springs are Reanimated spring configs — `snappy` for taps
 * and selections, `gentle` for sheets/cards entering. Durations are for
 * fades and simple timing transitions.
 */
export const motion = {
  duration: {
    fast: 180,
    base: 260,
    normal: 260,
    slow: 360,
  },
  spring: {
    snappy: { damping: 18, stiffness: 220 },
    gentle: { damping: 22, stiffness: 140 },
  },
} as const;

/** Minimum hit target (iOS HIG / Material guidance) for tappable elements. */
export const touchTarget = {
  minHeight: 48,
} as const;
