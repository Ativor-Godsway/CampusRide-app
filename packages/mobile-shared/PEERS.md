# Why every peer dependency here is marked `optional`

`@rida/mobile-shared` is a **source-only** internal package: `main` and
`types` both point straight at `src/index.ts`, it is never built or
published, and its only consumers are `apps/rider` and `apps/driver`.

Its peer dependencies (react, react-native, the expo-* modules, axios,
socket.io-client, …) are declared to document what a consumer must provide.
They were written as `"*"`, which npm 7+ takes as an instruction to *install*
them — and `"*"` resolves to the newest version on the registry. During the
SDK 54 → 57 upgrade that quietly pulled `react@19.3.0`, `react-native-maps`
and `react-native-safe-area-context` into the workspace root at versions
*newer* than the Expo SDK pins, so each app ended up nesting its own correct
copy alongside the root's wrong one. `expo-doctor` fails on exactly this, and
duplicate copies of React are a classic source of "Invalid hook call" crashes
and duplicate-native-module build errors.

`peerDependenciesMeta.*.optional = true` keeps the declarations (they still
document the contract, and a consumer that omits one still gets a warning
from tooling that checks peers) while telling npm not to materialise them.
Both apps already declare all 13 packages in their own `dependencies` — that
is verified, not assumed — so the apps remain the single source of truth for
versions, and `npx expo install --fix` in an app is all that is needed to
move an SDK forward.

The alternative was to pin each peer to the SDK's exact range here, which
would mean editing this file on every future SDK bump and getting a duplicate
tree again the moment it drifted.
