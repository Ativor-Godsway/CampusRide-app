/**
 * CampusRide design tokens: the values in docs/design-system.md ("Tokens
 * (exact values)"), for both the rider and driver apps. A change to the
 * design system is made here in the same PR.
 *
 * Names follow the spec in camelCase: `surface-2` is `colors.surface2`,
 * `space-5` is `spacing[5]`, `radius-md` is `radii.md`, `shadow-float` is
 * `shadows.float`, `control-lg` is `sizes.controlLg`.
 *
 * Older names that screens still use are kept as `@deprecated` aliases of
 * the closest spec token, so existing screens keep working while later
 * redesign PRs move them over. Don't use them in new code.
 */

import { Platform } from "react-native";
import { fonts } from "./fonts";

// ─── Colour (light theme only) ───────────────────────────────────────────────

const spec = {
  /** Page and sheet background in both apps. List screens are white, not grey. */
  surface: "#FFFFFF",
  /** Filled inputs, OTP boxes, neutral buttons, grouped info, icon tiles. Never a whole-page background. */
  surface2: "#F2F4F3",
  /** Pressed neutral controls, skeleton shimmer, disabled button fill. */
  surface3: "#E5E9E7",
  /** Hairline dividers between list rows and inside cards (decorative). */
  line: "#E6EAE8",
  /** Borders that carry meaning: unselected radio/checkbox outlines, the phone prefix divider. */
  lineStrong: "#7A8480",
  /** Primary text and icons on surface, surface-2 and green-50; selected filter chip fill. */
  ink: "#0F1311",
  /** Secondary text: subtitles, helper text, metadata. */
  ink2: "#4A5350",
  /** Tertiary text: placeholders, captions, timestamps (surface and surface-2 only). */
  ink3: "#646D69",
  /** Disabled icons and inactive tab icons. Never body text. */
  ink4: "#A3ABA8",
  /** Tonal button fill, selected ride option, pickup chip. */
  green50: "#E8F3EC",
  /** Progress track, slide-to-confirm track, pressed tonal button. */
  green100: "#CDE6D6",
  /** THE brand green: primary buttons, selected borders, route line, pickup pin, links. */
  green500: "#19743C",
  /** Pressed primary button. */
  green600: "#115C2F",
  /** Green text on green-50 and on surface (tonal button labels, Recommended chip). */
  green700: "#0F5429",
  /**
   * Chart bars that aren't the highlighted one (today's is green-500). Checked
   * against green-500 with the dataviz palette validator: distinct for normal
   * and colour-blind vision; under 3:1 on white, so a chart using it always
   * labels its bars.
   */
  chartBar: "#58A872",
  /** Text and icons on a green-500 or green-600 fill. */
  onBrand: "#FFFFFF",
  /** Green accents on a dark surface: Online dot, live pulse, earnings deltas. */
  greenOnDark: "#7BE0A0",
  /** Rating stars, the DRIVER badge, the live pulse core. Text on it is ink. Never a button. */
  amber400: "#FFBB29",
  /** Warning surface: out-of-area notice, "Waiting" chip. */
  amber50: "#FBF0DA",
  /** Text on amber-50. */
  amber700: "#7A5310",
  /** Danger text and borders: Cancel ride, Delete account, OTP error, SOS label. */
  red600: "#B42318",
  /** Danger surface: error notice, SOS sheet background. */
  red50: "#FDECEA",
  /** Dark feature surfaces: toast, earnings hero, cash-collected card. At most one per screen. */
  surfaceDark: "#0F1311",
  /** A raised element on surface-dark. */
  surfaceDark2: "#1C2220",
  /** Primary text on surface-dark. */
  onDark: "#FFFFFF",
  /** Secondary text on surface-dark. */
  onDark2: "#A9B3AF",
  /** Dims the map or screen behind a modal sheet. */
  scrim: "rgba(15,19,17,0.45)",
  /** The map's base tint. */
  mapLand: "#EEF0EA",
  /** Route polyline: the brand green. Upcoming legs on a multi-stop trip use it at 35%. */
  mapRoute: "#19743C",
} as const;

/**
 * A token colour at the given opacity (0–1), for tints — so a translucent
 * green is still derived from the one brand green. Accepts "#RRGGBB".
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

/** @deprecated The old green scale. Use green50 / green100 / green500 / green600 / green700. */
const primary = {
  50: spec.green50,
  100: spec.green100,
  200: spec.green100,
  300: spec.greenOnDark,
  400: spec.green500,
  500: spec.green500,
  600: spec.green600,
  700: spec.green700,
  800: spec.green700,
  900: spec.green700,
} as const;

/** @deprecated The old amber scale. Use amber50 / amber400 / amber700. */
const accent = {
  50: spec.amber50,
  100: spec.amber50,
  200: spec.amber400,
  300: spec.amber400,
  400: spec.amber400,
  500: spec.amber400,
  600: spec.amber700,
  700: spec.amber700,
} as const;

export const colors = {
  ...spec,

  /** @deprecated Use green50 … green700. */
  primary,
  /** @deprecated Use amber50 / amber400 / amber700. */
  accent,
  /** @deprecated Use surface (backgrounds), onBrand (on green) or onDark (on dark). */
  white: "#FFFFFF",
  /** @deprecated Pages are white now: use surface. */
  background: spec.surface,
  /** @deprecated Use surface2. */
  surfaceMuted: spec.surface2,
  /** @deprecated Use surface3. */
  surfaceSunken: spec.surface3,
  /** @deprecated Use line. */
  hairline: spec.line,
  /** @deprecated Use line. */
  border: spec.line,
  /** @deprecated Use surface3 (sheet handles) or lineStrong (borders that carry meaning). */
  borderStrong: spec.surface3,
  /** @deprecated Use surfaceDark2. */
  surfaceDarkElevated: spec.surfaceDark2,
  /** @deprecated Use surfaceDark2. */
  borderDark: spec.surfaceDark2,
  /** @deprecated Use greenOnDark. */
  glowGreen: spec.greenOnDark,
  /** @deprecated Use green500. */
  success: spec.green500,
  /** @deprecated Use green50. */
  successSurface: spec.green50,
  /** @deprecated Use red600. */
  error: spec.red600,
  /** @deprecated Use red50. */
  errorSurface: spec.red50,
  /** @deprecated Use red600. */
  danger: spec.red600,
  /** @deprecated Use amber700. */
  warning: spec.amber700,
  /** @deprecated Use amber50. */
  warningSurface: spec.amber50,
  /** @deprecated Use scrim. */
  overlay: spec.scrim,
} as const;

// ─── Type ────────────────────────────────────────────────────────────────────

/**
 * The type scale (Figtree). Each style names its weight's own font family
 * (fonts.*), never a fontWeight, so Android doesn't fake-bold it. Text
 * renders these by variant; use `textStyles` directly only for a TextInput.
 * Letter-spacing is the spec's em value times the font size.
 */
export const textStyles = {
  display: { fontFamily: fonts.extrabold, fontSize: 40, lineHeight: 44, letterSpacing: -1.2 },
  title1: { fontFamily: fonts.extrabold, fontSize: 28, lineHeight: 34, letterSpacing: -0.56 },
  title2: { fontFamily: fonts.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.22 },
  title3: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 24, letterSpacing: 0 },
  body: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 16, lineHeight: 22, letterSpacing: 0 },
  button: { fontFamily: fonts.bold, fontSize: 17, lineHeight: 22, letterSpacing: 0 },
  subhead: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  caption: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 16, letterSpacing: 0.12 },
  eyebrow: {
    fontFamily: fonts.bold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.96,
    textTransform: "uppercase",
  },
  plate: { fontFamily: fonts.extrabold, fontSize: 20, lineHeight: 24, letterSpacing: 1.2 },
} as const;

export type TextStyleName = keyof typeof textStyles;

/**
 * @deprecated The pre-Figtree scale. Use Text variants (or `textStyles`).
 * Kept because screens still set `fontSize: typography.size.md` and
 * `fontWeight: typography.weight.bold` on Text; Text turns that weight into
 * the matching Figtree family.
 */
export const typography = {
  fontFamily: {
    base: fonts.regular,
    /** System monospace. Use the `plate` variant or `tabular` instead. */
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
  letterSpacing: {
    tight: -0.5,
    tighter: -1,
    normal: 0,
    wide: 0.5,
    wider: 1,
  },
} as const;

// ─── Space, radius, elevation, size ──────────────────────────────────────────

/**
 * The 4px grid: `spacing[1]` … `spacing[10]` are the spec's space-1 …
 * space-10; `spacing.gutter` is the screen side gutter and sheet padding.
 */
export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  /** Screen side gutter and bottom-sheet padding (space-5). */
  gutter: 20,

  /** @deprecated Use spacing[1]. */
  xs: 4,
  /** @deprecated Use spacing[2]. */
  sm: 8,
  /** @deprecated Use spacing[3]. */
  md: 12,
  /** @deprecated Use spacing[4]. */
  lg: 16,
  /** @deprecated Use spacing[6]. */
  xl: 24,
  /** @deprecated Use spacing[8]. */
  "2xl": 32,
  /** @deprecated Use spacing[10]. */
  "3xl": 40,
  /** @deprecated Not on the spec scale; use sizes.controlLg for a 56px control. */
  "4xl": 56,
  /** @deprecated Not on the spec scale. */
  "5xl": 72,
} as const;

export const radii = {
  /** Plate frame, status chips, small thumbnails. */
  sm: 8,
  /** Buttons, inputs, OTP boxes, toasts. */
  md: 14,
  /** Cards and ride options. */
  lg: 20,
  /** Top corners of bottom sheets and full-screen offer cards. */
  xl: 28,
  /** Chips, round icon buttons, avatars, map pills. */
  full: 999,
  /** @deprecated Use xl (sheet tops). */
  "2xl": 28,
} as const;

/**
 * React Native versions of the spec's shadows (iOS shadow* + Android
 * elevation). Only things that float over the map get one.
 */
export const shadows = {
  /** Map pills, the recentre button, the Go online button, the toast. */
  float: {
    shadowColor: spec.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  /** Bottom sheets sitting on the map. */
  sheet: {
    shadowColor: spec.ink,
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 12,
  },

  /** @deprecated Use float, and only on things floating over the map. */
  sm: {
    shadowColor: spec.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  /** @deprecated Use float, and only on things floating over the map. */
  md: {
    shadowColor: spec.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  /** @deprecated Use sheet (bottom sheets) or float. */
  lg: {
    shadowColor: spec.ink,
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 12,
  },
} as const;

/** Control and element sizes (px). */
export const sizes = {
  /** Primary and secondary buttons, inputs, OTP box height. */
  controlLg: 56,
  /** Buttons inside cards; the minimum touch target. */
  controlMd: 48,
  /** Chips and small pill buttons (hit area padded to 48). */
  controlSm: 36,
  /** The driver's Go online / Go offline pill. */
  controlGo: 64,
  /** Round action buttons (Call, Message, Share, Safety). */
  iconButton: 56,
  /** Floating round map button (recentre, back). */
  mapButton: 44,
  /** Default icon size; 20 inside chips and a row's trailing slot. */
  icon: 24,
  iconSm: 20,
  /** Driver / rider photo on trip cards. */
  avatar: 56,
  /** Photo in a list row. */
  avatarSm: 40,
} as const;

/** Shared animation durations (ms). */
export const motion = {
  duration: {
    /** Press feedback. */
    fast: 120,
    /** Sheet content, list rows. */
    normal: 220,
    slow: 360,
  },
} as const;

/** Minimum hit target for tappable elements (control-md). */
export const touchTarget = {
  minHeight: sizes.controlMd,
} as const;
