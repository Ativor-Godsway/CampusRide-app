/**
 * app.json plus the one value that can't be static: where google-services.json
 * (Firebase, for Android push notifications) is.
 *
 * - On EAS Build: the secret EAS file variable GOOGLE_SERVICES_JSON, which EAS
 *   writes to a temporary path. The file itself is gitignored — this
 *   repository is public — and EAS only uploads files tracked by git.
 * - On this Mac: ./google-services.json, placed by hand
 *   (docs/runbooks/push-notifications.md, step 1).
 *
 * The update fingerprint hashes the file's CONTENTS, not its path, so the two
 * give the same fingerprint as long as they are the same file.
 *
 * Also: the iOS "fetch" background mode that expo-task-manager adds is
 * removed (plugins/withoutBackgroundFetch.js); background location stays.
 */
const withoutBackgroundFetch = require("./plugins/withoutBackgroundFetch");

module.exports = ({ config }) => ({
  ...config,
  plugins: [...(config.plugins ?? []), withoutBackgroundFetch],
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
  },
});
