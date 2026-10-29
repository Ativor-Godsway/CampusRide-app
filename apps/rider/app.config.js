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
  return {
    ...config,
    android: {
      ...config.android,
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
      ...(mapsKey && {
        config: { ...config.android?.config, googleMaps: { apiKey: mapsKey } },
      }),
    },
  };
};
