/**
 * Bundles one app's screens for react-native-web (see run.mjs). Every import
 * of something that only exists on a phone resolves to scripts/screens/stubs.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUBS = path.join(HERE, "stubs");

/** Module → stand-in. Anything not listed is the real package. */
const STAND_INS = {
  "react-native": "react-native.tsx",
  "react-native-safe-area-context": "safe-area-context.tsx",
  "react-native-maps": "maps.tsx",
  "react-native-gesture-handler": "gesture-handler.tsx",
  "@gorhom/bottom-sheet": "bottom-sheet.tsx",
  "react-native-svg": "svg.tsx",
  "@expo/vector-icons": "vector-icons.tsx",
  "expo-router": "expo-router.tsx",
  "expo-image": "expo-image.tsx",
  "expo-font": "expo-modules.ts#font",
  "expo-haptics": "expo-modules.ts#haptics",
  "expo-secure-store": "expo-modules.ts#secureStore",
  "expo-constants": "expo-modules.ts#constants",
  "expo-device": "expo-modules.ts#device",
  "expo-application": "expo-modules.ts#application",
  "expo-updates": "expo-modules.ts#updates",
  "expo-notifications": "expo-modules.ts#notifications",
  "expo-location": "expo-modules.ts#location",
  "expo-task-manager": "expo-modules.ts#taskManager",
  "expo-keep-awake": "expo-modules.ts#keepAwake",
  "expo-audio": "expo-modules.ts#audio",
  "expo-image-picker": "expo-modules.ts#imagePicker",
  "expo-file-system": "expo-modules.ts#fileSystem",
  "expo-web-browser": "expo-modules.ts#webBrowser",
  "expo-linking": "expo-modules.ts#linking",
  "expo-status-bar": "expo-modules.ts#statusBar",
  "@sentry/react-native": "expo-modules.ts#sentry",
  "socket.io-client": "expo-modules.ts#socket",
};

/** "a.ts#name" stand-ins re-export one namespace of a shared stub file as a module. */
function standInPath(spec, outDir) {
  const target = STAND_INS[spec];
  const [file, ns] = target.split("#");
  if (!ns) return path.join(STUBS, file);
  const shim = path.join(outDir, "stand-ins", `${spec.replace(/[^a-z0-9]+/gi, "_")}.ts`);
  mkdirSync(path.dirname(shim), { recursive: true });
  const src = path.join(STUBS, file).replace(/\\/g, "/");
  writeFileSync(shim, `import { ${ns} } from ${JSON.stringify(src)};\nexport = ${ns};\n`);
  return shim;
}

/** Width and height from a PNG's header, so Image.resolveAssetSource works. */
function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export async function buildBundle({ app, root, cache, outDir }) {
  const req = createRequire(path.join(cache, "package.json"));
  const esbuild = req("esbuild");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "assets"), { recursive: true });

  const redirect = {
    name: "campusride-stand-ins",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (a) => {
        const m = /^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/.exec(a.path);
        if (!m) return undefined;
        const [, pkg, sub = ""] = m;
        // One React for everything: the tools' copy, the apps' version.
        if (pkg === "react" || pkg === "react-dom") return { path: req.resolve(pkg + sub) };
        if (pkg === "react-native-web") return { path: req.resolve(pkg + sub) };
        if (STAND_INS[pkg] && !sub) return { path: standInPath(pkg, outDir) };
        if (pkg === "react-native" && sub) return { path: path.join(STUBS, "react-native.tsx") };
        if (pkg === "expo-router" && sub) return { path: path.join(STUBS, "expo-router.tsx") };
        if (pkg === "@rida/shared")
          return { path: path.join(root, "packages/shared/src/index.ts") };
        if (pkg === "@rida/mobile-shared")
          return { path: path.join(root, "packages/mobile-shared/src/index.ts") };
        return undefined;
      });
      // Images: { uri, width, height }, which react-native-web's Image takes.
      b.onLoad({ filter: /\.png$/ }, (a) => {
        const name = `${path.basename(a.path, ".png")}-${Buffer.from(a.path).toString("base64url").slice(-10)}.png`;
        copyFileSync(a.path, path.join(outDir, "assets", name));
        const { width, height } = pngSize(a.path);
        return {
          contents: `module.exports = ${JSON.stringify({ uri: `assets/${name}`, width, height })};`,
          loader: "js",
        };
      });
    },
  };

  await esbuild.build({
    entryPoints: [path.join(HERE, "harness", `${app}.tsx`)],
    bundle: true,
    outfile: path.join(outDir, "bundle.js"),
    format: "iife",
    platform: "browser",
    plugins: [redirect],
    loader: { ".ttf": "file", ".wav": "file", ".mp3": "file", ".js": "jsx" },
    jsx: "automatic",
    resolveExtensions: [
      ".web.tsx",
      ".web.ts",
      ".tsx",
      ".ts",
      ".web.js",
      ".jsx",
      ".js",
      ".mjs",
      ".json",
    ],
    mainFields: ["browser", "module", "main"],
    conditions: ["browser", "import", "default"],
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.EXPO_OS": '"ios"',
      global: "globalThis",
    },
    assetNames: "assets/[name]-[hash]",
    publicPath: "./",
    logLevel: "error",
    // Expo's own packages ship untranspiled `import type` etc.; esbuild handles it.
    target: "es2022",
  });

  // Fonts by family name, as the apps register them.
  const fontDir = path.join(outDir, "fonts");
  mkdirSync(fontDir, { recursive: true });
  const rootReq = createRequire(path.join(root, "package.json"));
  const faces = [];
  for (const w of ["400Regular", "500Medium", "600SemiBold", "700Bold", "800ExtraBold"]) {
    const file = rootReq.resolve(`@expo-google-fonts/figtree/${w}/Figtree_${w}.ttf`);
    copyFileSync(file, path.join(fontDir, path.basename(file)));
    faces.push(`@font-face{font-family:Figtree_${w};src:url(fonts/${path.basename(file)})}`);
  }
  const ionicons = rootReq.resolve(
    "@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf",
  );
  copyFileSync(ionicons, path.join(fontDir, "Ionicons.ttf"));
  faces.push("@font-face{font-family:Ionicons;src:url(fonts/Ionicons.ttf)}");

  writeFileSync(
    path.join(outDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=390">
<style>${faces.join("")}
html,body{margin:0;height:100%;background:#fff;font-family:Figtree_400Regular,system-ui}
#root{display:flex;flex-direction:column;height:100%}
/* A phone draws no focus ring around a text field. */
input:focus,textarea:focus{outline:none}</style>
<script>window.__DEV__=false;window.process={env:{NODE_ENV:"production"}};</script>
</head><body><div id="root"></div><script src="bundle.js"></script></body></html>`,
  );
}
