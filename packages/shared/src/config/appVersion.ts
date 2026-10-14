/**
 * The "Version 1.0.0 · update 3f9c2a1b · 14 Oct 2026 · production" line at the
 * bottom of the rider and driver account screens, so anyone can tell which
 * over-the-air update a phone is running (docs/runbooks/releasing.md). Pure,
 * so it can be tested here; the apps call it through @rida/mobile-shared's
 * getAppVersionLabel(), which reads the values from expo-updates.
 */

export interface AppVersionInputs {
  /** expo.version from app.json, e.g. "1.0.0". */
  version: string | undefined;
  /** False under `expo start` / Expo Go, where EAS Update is switched off. */
  updatesEnabled: boolean;
  /** True when running the JavaScript that shipped inside the store build. */
  isEmbeddedLaunch: boolean;
  /** ID of the running update; the EAS dashboard shows the same ID. */
  updateId: string | null;
  /** When the running update was published. */
  createdAt: Date | null;
  /** The build's channel: development, preview or production. */
  channel: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function describeAppVersion(inputs: AppVersionInputs): string {
  const parts = [`Version ${inputs.version ?? "?"}`];
  if (!inputs.updatesEnabled) {
    parts.push("dev");
  } else {
    if (inputs.isEmbeddedLaunch || !inputs.updateId) {
      parts.push("built-in");
    } else {
      parts.push(`update ${inputs.updateId.slice(0, 8)}`);
      // UTC, so the date matches the EAS dashboard wherever the phone is.
      const d = inputs.createdAt;
      if (d && !Number.isNaN(d.getTime())) {
        parts.push(`${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`);
      }
    }
    if (inputs.channel) parts.push(inputs.channel);
  }
  return parts.join(" · ");
}
