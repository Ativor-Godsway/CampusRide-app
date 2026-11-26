/**
 * app.json plus the values that can't be static:
 *
 * 1. Where google-services.json (Firebase, for Android push notifications) is.
 *    - On EAS Build: the secret EAS file variable GOOGLE_SERVICES_JSON, which
 *      EAS writes to a temporary path. The file itself is gitignored — this
 *      repository is public — and EAS only uploads files tracked by git.
 *    - On this Mac: ./google-services.json, placed by hand
 *      (docs/runbooks/push-notifications.md, step 1).
 *    The update fingerprint hashes the file's CONTENTS, not its path, so the
 *    two give the same fingerprint as long as they are the same file.
 *
 * 2. The Google Maps API key, from the EAS variable GOOGLE_MAPS_ANDROID_API_KEY
 *    (docs/runbooks/google-maps-android.md). On Android, react-native-maps
 *    draws with the Google Maps SDK, which crashes the app the moment a map
 *    opens if the key is missing (Expo Go has its own key, so only real
 *    builds show it). iOS uses Apple Maps and ignores it. The key's value is
 *    part of the fingerprint, so an EAS build without it fails here rather
 *    than ship a crashing app that no update would reach.
 */
module.exports = ({ config }) => {
  const mapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  if (process.env.EAS_BUILD && !mapsKey) {
    throw new Error(
      "GOOGLE_MAPS_ANDROID_API_KEY is not set: Android builds would crash on the map. See docs/runbooks/google-maps-android.md.",
    );
  }
  const production = {
    ...config,
    android: {
      ...config.android,
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
      ...(mapsKey && {
        config: { ...config.android?.config, googleMaps: { apiKey: mapsKey } },
      }),
    },
  };
  // Every production build and update: exactly the config above.
  if (!isStaging()) return production;
  return stagingVariant(production, "CampusRide Staging");
};

/**
 * Whether to resolve the STAGING app: APP_VARIANT=staging (set by
 * scripts/eas-update.sh staging, or by hand for `expo start`), or an EAS
 * build with the "preview" profile — which builds the staging app.
 * (A new "staging" profile isn't possible: eas.json is part of every app's
 * fingerprint, so editing it would force new store builds.)
 */
function isStaging() {
  return process.env.APP_VARIANT === "staging" || process.env.EAS_BUILD_PROFILE === "preview";
}

/**
 * The STAGING app (STAGING.md): its own name,
 * bundle id / package and deep-link scheme, so it installs NEXT TO the store
 * app; the icon with a STAGING band; the staging server (and only it:
 * extra.APP_VARIANT makes the app ignore any other URL); updates through the
 * "preview" channel, which points at the EAS branch "staging". Its fingerprint differs from
 * production's, so production updates never reach it and staging updates
 * never reach a store build.
 *
 * Android push needs a Firebase file that lists the staging package: the EAS
 * file variable GOOGLE_SERVICES_JSON_STAGING on EAS, or
 * ./google-services.staging.json on this Mac. Without one the app builds
 * and runs, without Android push.
 */
const STAGING_API_URL = "https://campusride-staging-api.onrender.com";

function stagingVariant(production, name) {
  const fs = require("node:fs");
  const id = `${production.ios.bundleIdentifier}.staging`;
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON_STAGING ??
    (fs.existsSync(`${__dirname}/google-services.staging.json`) ? "./google-services.staging.json" : undefined);
  const android = { ...production.android, package: `${production.android.package}.staging`, googleServicesFile };
  if (!googleServicesFile) delete android.googleServicesFile;
  if (android.adaptiveIcon) android.adaptiveIcon = { ...android.adaptiveIcon, foregroundImage: "./assets/adaptive-icon-staging.png" };
  return {
    ...production,
    name,
    scheme: `${production.scheme}-staging`,
    icon: "./assets/icon-staging.png",
    ios: { ...production.ios, bundleIdentifier: id },
    android,
    extra: { ...production.extra, SERVER_URL: STAGING_API_URL, APP_VARIANT: "staging" },
  };
}
