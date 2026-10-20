#!/usr/bin/env node
/* global window, document, getComputedStyle -- inside page.evaluate(), which runs in the browser */
/**
 * Screenshots of the rider and driver apps without a phone:
 *
 *   npm run screens -- pr-03                 every scene, both apps
 *   npm run screens -- pr-03 --app driver    one app
 *   npm run screens -- pr-03 --only home,trip
 *   npm run screens -- pr-03 --out ~/somewhere
 *
 * PNGs (390 px wide, 2x) go to ~/Desktop/CampusRide UI audit/pr-screens/<name>/
 * unless --out says otherwise. They are NOT committed.
 *
 * How: the apps' real screens (and root layouts) are bundled with esbuild
 * for react-native-web, with small stand-ins for what only exists on a phone
 * (scripts/screens/stubs: maps become a grey box, the bottom sheet a plain
 * panel, no native modules) and a fake server with made-up data
 * (scripts/screens/harness). Headless Chrome renders each scene.
 *
 * It is a picture of the layout, type and colour, not a phone: native
 * shadows, the keyboard, gestures and maps look different on a device.
 *
 * Its own tools (react-native-web, esbuild, puppeteer-core) install once into
 * node_modules/.cache/campusride-screens, outside the workspaces, so the
 * apps' dependencies, the lockfile and the update fingerprint never change.
 * It uses the Chrome already on this Mac (or CHROME_PATH).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CACHE = path.join(ROOT, "node_modules/.cache/campusride-screens");
const APPS = ["rider", "driver"];

// ─── Arguments ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const name = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!name) {
  console.error(
    "Usage: npm run screens -- <folder name, e.g. pr-03> [--app rider|driver] [--only a,b] [--out dir]",
  );
  process.exit(1);
}
const apps = flag("app") ? [flag("app")] : APPS;
for (const app of apps) {
  if (!APPS.includes(app)) {
    console.error(`--app must be one of: ${APPS.join(", ")}`);
    process.exit(1);
  }
}
const only = flag("only")
  ?.split(",")
  .map((s) => s.trim());
const outRoot =
  flag("out")?.replace(/^~(?=$|\/)/, homedir()) ??
  path.join(homedir(), "Desktop/CampusRide UI audit/pr-screens");
const outDir = path.join(outRoot, name);

// ─── Tools, installed once ───────────────────────────────────────────────────

/** React must be the apps' own version; the rest are this script's. */
const reactVersion = JSON.parse(readFileSync(path.join(ROOT, "apps/rider/package.json"), "utf8"))
  .dependencies.react;
const TOOLS = {
  react: reactVersion,
  "react-dom": reactVersion,
  "react-native-web": "0.21.2",
  esbuild: "0.28.2",
  "puppeteer-core": "24.43.1",
};

function ensureTools() {
  const stamp = path.join(CACHE, "tools.json");
  const wanted = JSON.stringify(TOOLS);
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === wanted) return;
  console.log("Installing the screenshot tools (once)…");
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(
    path.join(CACHE, "package.json"),
    JSON.stringify({ name: "campusride-screens", private: true }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      ...Object.entries(TOOLS).map(([pkg, v]) => `${pkg}@${v}`),
    ],
    { cwd: CACHE, stdio: "inherit" },
  );
  writeFileSync(stamp, wanted);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error("No Chrome found. Install Google Chrome, or set CHROME_PATH.");
    process.exit(1);
  }
  return found;
}

// ─── Build ───────────────────────────────────────────────────────────────────

async function build(app) {
  const { buildBundle } = await import(pathToFileURL(path.join(HERE, "build.mjs")).href);
  const dir = path.join(CACHE, "build", app);
  await buildBundle({ app, root: ROOT, cache: CACHE, outDir: dir });
  return dir;
}

// ─── Capture ─────────────────────────────────────────────────────────────────

const WIDTH = 390;
const HEIGHT = 844;

async function capture(browser, app, dir) {
  const index = pathToFileURL(path.join(dir, "index.html")).href;
  // The scene list: index.html with no scene named renders nothing.
  const lister = await browser.newPage();
  await lister.goto(index, { waitUntil: "load" });
  const scenes = await lister.evaluate(() => window.__screens.list());
  await lister.close();

  const results = [];
  for (const scene of scenes) {
    if (only && !only.includes(scene.name)) continue;
    const errors = [];
    const tab = await browser.newPage();
    tab.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error" || text.startsWith("[screens]")) errors.push(text);
    });
    tab.on("pageerror", (err) => errors.push(String(err)));
    await tab.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
    await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await tab.goto(`${index}#${scene.name}`, { waitUntil: "load" });
    await tab
      .waitForFunction(() => window.__screens?.ready === true, { timeout: 20_000 })
      .catch(() => {
        errors.push("[screens] timed out waiting for the scene to settle");
      });
    await tab.evaluate(() => document.fonts.ready);

    if (scene.full) {
      // Grow the window until the longest scroll view shows all its content.
      for (let i = 0; i < 3; i++) {
        const extra = await tab.evaluate(() => {
          let most = 0;
          for (const el of document.querySelectorAll("*")) {
            const style = getComputedStyle(el);
            if (/(auto|scroll)/.test(style.overflowY))
              most = Math.max(most, el.scrollHeight - el.clientHeight);
          }
          return most;
        });
        if (extra <= 1) break;
        const { height } = tab.viewport();
        await tab.setViewport({ width: WIDTH, height: height + extra, deviceScaleFactor: 2 });
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const file = path.join(outDir, `${app}-${scene.name}.png`);
    await tab.screenshot({ path: file });
    results.push({ file, scene, errors: [...errors] });
    await tab.close();
  }
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

ensureTools();
const chrome = findChrome();
mkdirSync(outDir, { recursive: true });

const puppeteer = (
  await import(
    pathToFileURL(
      path.join(CACHE, "node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js"),
    ).href
  )
).default;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--allow-file-access-from-files", "--hide-scrollbars", "--font-render-hinting=none"],
});

let failed = false;
try {
  for (const app of apps) {
    console.log(`\n${app}: building…`);
    const dir = await build(app);
    const results = await capture(browser, app, dir);
    for (const { file, scene, errors } of results) {
      const note = scene.note ? `  (${scene.note})` : "";
      console.log(`  ✓ ${path.basename(file)}${note}`);
      for (const e of errors) console.log(`      ! ${e.split("\n")[0].slice(0, 300)}`);
      if (errors.some((e) => !e.startsWith("[screens]"))) failed = true;
    }
  }
} finally {
  await browser.close();
}

const saved = readdirSync(outDir).filter((f) => f.endsWith(".png")).length;
console.log(`\n${saved} screenshot(s) in ${outDir}`);
if (failed) {
  console.log("Some scenes logged errors (above); their screenshots may be incomplete.");
  process.exitCode = 1;
}
