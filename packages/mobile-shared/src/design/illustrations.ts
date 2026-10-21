/* eslint-disable @typescript-eslint/no-require-imports -- Metro bundles images via require(); this is the standard React Native pattern. */
import type { ImageSourcePropType } from "react-native";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  APP ARTWORK: the ONE place every 3D illustration is listed.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  To CHANGE an image:  drop a new PNG into
 *     packages/mobile-shared/assets/illustrations/
 *  using the SAME file name (e.g. overwrite `car-idle.png`). Nothing else to do.
 *
 *  To ADD an image:  put the PNG in that folder and add one line below.
 *
 *  Tips: transparent background, square, about 512×512 px. Non-square art
 *  (the 720×540 cars) is fine too — render it with <Illustration width={…}>.
 *  Both the rider and driver apps read from here.
 */
export const illustrations = {
  // Cars
  /** Realistic 4:3 cars for the rider's ride-choice list. Use with `width`, not `size`. */
  carStandard: require("../../assets/illustrations/car-standard.png"),
  carShared: require("../../assets/illustrations/car-shared.png"),
  /** The driver on the map, seen from above (front of the car points up). */
  carTopdown: require("../../assets/illustrations/car-topdown.png"),
  noDrivers: require("../../assets/illustrations/no-drivers.png"),

  // Map pins
  pinPickup: require("../../assets/illustrations/pin-pickup.png"),
  pinDropoff: require("../../assets/illustrations/pin-dropoff.png"),

  // Screens
  safetyShield: require("../../assets/illustrations/safety-shield.png"),

  // Brand
  logoMark: require("../../assets/illustrations/logo-mark.png"),
} satisfies Record<string, ImageSourcePropType>;

export type IllustrationName = keyof typeof illustrations;
