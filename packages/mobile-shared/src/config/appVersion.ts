import Constants from "expo-constants";
import { channel, createdAt, isEmbeddedLaunch, isEnabled, updateId } from "expo-updates";
import { describeAppVersion } from "@rida/shared";

/**
 * The version line shown at the bottom of the account screens (rules and
 * tests: @rida/shared config/appVersion.ts). Read-only: this module never
 * checks for, downloads or applies an update — expo-updates does that on its
 * own at launch (app.json `updates`), and a new update only takes effect the
 * next time the app starts, so nobody is interrupted mid-ride.
 */
export function getAppVersionLabel(): string {
  return describeAppVersion({
    version: Constants.expoConfig?.version,
    updatesEnabled: isEnabled,
    isEmbeddedLaunch,
    updateId,
    createdAt,
    channel,
  });
}
