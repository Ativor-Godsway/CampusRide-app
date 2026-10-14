#!/usr/bin/env node
// eas-google-services.mjs — puts the app's google-services.json in place on
// an EAS Build worker, before `expo prebuild` reads it.
//
// Run by EAS as the `eas-build-post-install` hook in apps/<app>/package.json,
// from inside apps/<app>/. The file is gitignored (the repository is public and
// it carries a Firebase API key), so EAS never uploads it; instead it comes
// from the secret EAS file variable GOOGLE_SERVICES_JSON, which EAS writes to a
// temporary path. Copying it to ./google-services.json — the same path app.json
// names on this Mac — keeps the app config, and so the update fingerprint,
// identical between builds and `eas update` (docs/runbooks/push-notifications.md).

import { copyFileSync, existsSync } from "node:fs";

const target = "./google-services.json";
const source = process.env.GOOGLE_SERVICES_JSON;

if (source && existsSync(source)) {
  copyFileSync(source, target);
  console.log("google-services.json: copied from the GOOGLE_SERVICES_JSON EAS variable.");
} else if (existsSync(target)) {
  console.log("google-services.json: already present.");
} else if (process.env.EAS_BUILD_PLATFORM === "android") {
  console.error(
    "google-services.json is missing. Create the EAS file variable GOOGLE_SERVICES_JSON for this app " +
      "(docs/runbooks/push-notifications.md, step 2).",
  );
  process.exit(1);
}
