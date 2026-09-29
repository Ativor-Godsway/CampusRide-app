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
  carIdle: require("../../assets/illustrations/car-idle.png"),
  carFull: require("../../assets/illustrations/car-full.png"),
  carTopdown: require("../../assets/illustrations/car-topdown.png"),
  serviceRide: require("../../assets/illustrations/service-ride.png"),
  noDrivers: require("../../assets/illustrations/no-drivers.png"),

  // Map pins
  pinPickup: require("../../assets/illustrations/pin-pickup.png"),
  pinDropoff: require("../../assets/illustrations/pin-dropoff.png"),
  pinRadar: require("../../assets/illustrations/pin-radar.png"),

  // Empty / status screens
  searchEmpty: require("../../assets/illustrations/search-empty.png"),
  historyEmpty: require("../../assets/illustrations/history-empty.png"),
  ridesEmpty: require("../../assets/illustrations/rides-empty.png"),
  offline: require("../../assets/illustrations/offline.png"),
  tripComplete: require("../../assets/illustrations/trip-complete.png"),
  driverOnboarding: require("../../assets/illustrations/driver-onboarding.png"),
  safetyShield: require("../../assets/illustrations/safety-shield.png"),

  // Rider home services
  serviceFood: require("../../assets/illustrations/service-food.png"),
  serviceCourier: require("../../assets/illustrations/service-courier.png"),

  // Brand
  logoMark: require("../../assets/illustrations/logo-mark.png"),
} satisfies Record<string, ImageSourcePropType>;

export type IllustrationName = keyof typeof illustrations;
