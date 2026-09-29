import { spacing } from "@rida/mobile-shared";

/**
 * Bottom padding for the scroll content of a TAB screen (Home, Rides,
 * Account), so the last row always ends clear of the tab bar with room to
 * breathe.
 *
 * Deliberately NOT the tab bar's height: in expo-router's tabs the tab bar
 * is laid out BELOW the screen (a column), not drawn over it, so its height
 * — safe-area inset included — is already excluded from the scroll area.
 * Tab screens use Screen edges={["top"]} for the same reason: the tab bar
 * owns the bottom inset.
 */
export const TAB_SCREEN_BOTTOM_PADDING = spacing["3xl"];
