import {
  DEFAULT_STORE_URLS,
  normalizeStoreUrl,
  parseVersion,
  type AppKind,
  type AppMinVersions,
  type AppPlatform,
} from "@rida/shared";

type Env = Record<string, string | undefined>;

const APPS: AppKind[] = ["rider", "driver"];
const PLATFORMS: AppPlatform[] = ["ios", "android"];

/** MIN_VERSION_RIDER_IOS, STORE_URL_DRIVER_ANDROID, … */
export function minVersionVar(app: AppKind, platform: AppPlatform): string {
  return `MIN_VERSION_${app.toUpperCase()}_${platform.toUpperCase()}`;
}

export function storeUrlVar(app: AppKind, platform: AppPlatform): string {
  return `STORE_URL_${app.toUpperCase()}_${platform.toUpperCase()}`;
}

/**
 * What GET /app/min-version answers (docs/runbooks/releasing.md, "Forcing an
 * update"), from eight optional Render variables. An unset minimum blocks
 * nobody. An unset store link falls back to the app's Google Play page on
 * Android and to none on iOS (no App Store listing yet). A value that can't
 * be used — a minimum that isn't "1.2.0"-shaped, a link that isn't https —
 * counts as unset and is named in `invalid` (the names only: index.ts warns
 * with them at boot).
 */
export function resolveAppMinVersions(env: Env): { versions: AppMinVersions; invalid: string[] } {
  const invalid: string[] = [];
  const read = (name: string, valid: (value: string) => boolean): string | null => {
    const value = env[name]?.trim();
    if (!value) return null;
    if (valid(value)) return value;
    invalid.push(name);
    return null;
  };

  const versions = {} as AppMinVersions;
  for (const app of APPS) {
    versions[app] = {} as AppMinVersions[AppKind];
    for (const platform of PLATFORMS) {
      versions[app][platform] = {
        minVersion: read(minVersionVar(app, platform), (v) => parseVersion(v) !== null),
        storeUrl:
          read(storeUrlVar(app, platform), (v) => normalizeStoreUrl(v) !== null) ??
          DEFAULT_STORE_URLS[app][platform],
      };
    }
  }
  return { versions, invalid };
}
