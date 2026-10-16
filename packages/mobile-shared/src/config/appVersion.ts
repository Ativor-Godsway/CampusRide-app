import { Alert } from "react-native";
import Constants from "expo-constants";
import * as Application from "expo-application";
import {
  channel,
  createdAt,
  isEmbeddedLaunch,
  isEnabled,
  runtimeVersion,
  updateId,
} from "expo-updates";
import { describeAppAbout, describeAppVersion } from "@rida/shared";

/**
 * The version line shown at the bottom of the account screens (rules and
 * tests: @rida/shared config/appVersion.ts). Read-only: this module never
 * checks for, downloads or applies an update — expo-updates does that on its
 * own at launch (app.json `updates`), and a new update only takes effect the
 * next time the app starts, so nobody is interrupted mid-ride.
 */
function inputs() {
  return {
    version: Constants.expoConfig?.version,
    buildNumber: Application.nativeBuildVersion,
    updatesEnabled: isEnabled,
    isEmbeddedLaunch,
    updateId,
    createdAt,
    channel,
  };
}

export function getAppVersionLabel(): string {
  return describeAppVersion(inputs());
}

/**
 * Long-press on the version line: "About this app" with the version, build
 * number, full update ID, channel and runtime, for a tester to read out.
 */
export function showAppAbout(): void {
  Alert.alert("About this app", describeAppAbout({ ...inputs(), runtimeVersion }));
}
