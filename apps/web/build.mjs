/**
 * Builds the CampusRide website (https://campusride.app) into dist/.
 *
 * No dependencies and no install step: Render runs `node apps/web/build.mjs`
 * and publishes apps/web/dist. Each page in src/pages is wrapped in
 * src/layout.html, `{{name}}` values are filled in from site.config.mjs, and
 * sitemap.xml and robots.txt are written from the page list below.
 *
 * Facts the code owns are read from the repo's source at build time, so the
 * website can't say something different from what the apps and the server do:
 * - the fares and the commission (packages/shared/src/pricing/pricing.ts),
 * - the account-deletion retention period and the terms' date (@rida/shared),
 * - the pickup areas in service (apps/server/src/scripts/realignZones.ts),
 * - the welcome animation (packages/mobile-shared/assets/welcome/welcome.json),
 * - the roads on the "Where we operate" map (assets/map/legon-osm.json, OpenStreetMap).
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { site } from "./site.config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Every page, in sitemap order. `slug` "" is the home page. `{{name}}` works in descriptions. */
export const pages = [
  {
    slug: "",
    title: "CampusRide: rides around the University of Ghana, Legon",
    description:
      "Shared rides for {{sharedFare}} a rider and private rides for {{loneFare}} around the University of Ghana, Legon. The fare is fixed, shown before you book and paid to your driver in cash.",
  },
  {
    slug: "privacy",
    title: "Privacy Policy | CampusRide",
    description:
      "What personal data the CampusRide rider and driver apps collect, why, who it is shared with, where it is stored, how long it is kept, and your rights under Ghana's Data Protection Act, 2012 (Act 843).",
  },
  {
    slug: "terms",
    title: "Terms of Service | CampusRide",
    description:
      "The terms for riders and drivers using CampusRide: eligibility, cash fares, cancellations, conduct, safety and SOS, and limits of liability.",
  },
  {
    slug: "support",
    title: "Support | CampusRide",
    description:
      "Get help with CampusRide: contact support by email or phone, and answers to common questions from riders and drivers.",
  },
  {
    slug: "delete-account",
    title: "Delete your account | CampusRide",
    description:
      "How to delete your CampusRide account in the app, or by email without the app, and exactly what is deleted and what is kept.",
  },
];

/** Shown, highlighted, where a site.config value hasn't been filled in yet. */
const PLACEHOLDER_LABELS = {
  operatorName: "OPERATOR'S FULL LEGAL NAME",
  operatorAddress: "OPERATOR'S POSTAL ADDRESS",
  supportPhone: "SUPPORT PHONE NUMBER",
};

/** The header's links: sections of the home page, then Support. */
const NAV = [
  { href: "/#how", label: "How it works" },
  { href: "/#prices", label: "Prices" },
  { href: "/#safety", label: "Safety" },
  { href: "/#drive", label: "Drive" },
  { href: "/#faq", label: "FAQ" },
  { href: "/support", label: "Support" },
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const readSource = (root, path) => readFileSync(join(root, path), "utf8");

/** ACCOUNT_DELETION_RETENTION_DAYS from packages/shared/src/account/deletion.ts. */
export function readRetentionDays(root = repoRoot) {
  const source = readSource(root, "packages/shared/src/account/deletion.ts");
  const match = source.match(/export const ACCOUNT_DELETION_RETENTION_DAYS = (\d+);/);
  if (!match) throw new Error("ACCOUNT_DELETION_RETENTION_DAYS not found in @rida/shared");
  return Number(match[1]);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * TERMS_VERSION from packages/shared/src/account/terms.ts, as the pages'
 * "Last updated" date ("18 October 2026"). The apps record this version when
 * someone ticks "I agree to the Terms and Privacy Policy", so the date on the
 * pages and the version on the account can't disagree.
 */
export function readTermsDate(root = repoRoot) {
  const source = readSource(root, "packages/shared/src/account/terms.ts");
  const match = source.match(/export const TERMS_VERSION = "(\d{4})-(\d{2})-(\d{2})";/);
  if (!match) throw new Error("TERMS_VERSION (YYYY-MM-DD) not found in @rida/shared");
  const [, year, month, day] = match;
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/**
 * The fares and the commission from PRICING in packages/shared/src/pricing/pricing.ts,
 * in pesewas, so the site can never show an old price. The site says "per
 * rider" for shared rides, so it refuses to build if the shared fare stops
 * being the same at every occupancy.
 */
export function readPricing(root = repoRoot) {
  const source = readSource(root, "packages/shared/src/pricing/pricing.ts");
  const number = (key) => {
    const match = source.match(new RegExp(`\\b${key}: (\\d+),`));
    if (!match) throw new Error(`PRICING.${key} not found in @rida/shared`);
    return Number(match[1]);
  };
  const shared = source.match(/SHARED_FARES: \{([^}]*)\}/);
  if (!shared) throw new Error("PRICING.SHARED_FARES not found in @rida/shared");
  const fares = [...shared[1].matchAll(/\d+: (\d+)/g)].map((m) => Number(m[1]));
  if (!fares.length || fares.some((f) => f !== fares[0])) {
    throw new Error(
      `The shared fare is no longer the same for every rider count (${fares.join(", ")}): ` +
        "the website's prices section says one fare per rider and needs rewording.",
    );
  }
  return {
    sharedFare: fares[0],
    loneFare: number("LONE_FARE"),
    maxSharedRiders: number("MAX_SHARED_OCCUPANCY"),
    commissionPct: number("COMMISSION_PCT"),
  };
}

/** Pesewas as the apps show them (@rida/shared formatCedis): "GH₵7", "GH₵12.75". */
export function formatCedis(pesewas) {
  const whole = Math.floor(pesewas / 100);
  const cents = pesewas % 100;
  return `GH₵${cents === 0 ? whole : `${whole}.${String(cents).padStart(2, "0")}`}`;
}

/**
 * The pickup areas in service: REAL_ZONE_CENTRES in the server's
 * realignZones.ts (name and real position, from OpenStreetMap), less the
 * RETIRED_ZONES. In alphabetical order, as the map numbers them.
 */
export function readZones(root = repoRoot) {
  const source = readSource(root, "apps/server/src/scripts/realignZones.ts");
  const block = source.match(/REAL_ZONE_CENTRES[^=]*= \{([\s\S]*?)\n\};/);
  if (!block) throw new Error("REAL_ZONE_CENTRES not found in realignZones.ts");
  const retired = [...(source.match(/RETIRED_ZONES = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  );
  const zones = [
    ...block[1].matchAll(/"([^"]+)": \{\s*latitude: (-?[\d.]+),\s*longitude: (-?[\d.]+)/g),
  ].map(([, name, latitude, longitude]) => ({
    name,
    latitude: Number(latitude),
    longitude: Number(longitude),
  }));
  if (zones.length < 2) throw new Error("Fewer than two zones read from realignZones.ts");
  return zones
    .filter((z) => !retired.includes(z.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

// ─── The "Where we operate" map ──────────────────────────────────────────────

/** Road widths in map units (the map is 1000 wide), trunk to service, as in the harness's maps. */
const ROAD_WIDTHS = [9, 7, 5, 3.2, 1.6];

/** Douglas–Peucker: drops points closer than `tolerance` to the line. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  let worst = 0;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    const d = Math.abs(dy * x - dx * y + b[0] * a[1] - b[1] * a[0]) / length;
    if (d > worst) [worst, at] = [d, i];
  }
  if (worst <= tolerance) return [a, b];
  return [...simplify(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplify(points.slice(at), tolerance)];
}

/**
 * An SVG map of campus: the OpenStreetMap roads and green areas from
 * assets/map/legon-osm.json, with each zone as a numbered green dot (the
 * page lists the names under the same numbers).
 */
export function whereMap(zones, root = repoRoot) {
  const osm = JSON.parse(readSource(root, "assets/map/legon-osm.json"));
  const WIDTH = 1000;
  const HEIGHT = 1300;
  const lats = zones.map((z) => z.latitude);
  const lngs = zones.map((z) => z.longitude);
  const [south, north] = [Math.min(...lats) - 0.0024, Math.max(...lats) + 0.0024];
  const centreLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const cos = Math.cos((((south + north) / 2) * Math.PI) / 180);
  const scale = HEIGHT / (north - south); // map units per degree of latitude
  const west = centreLng - WIDTH / 2 / (scale * cos);
  const project = (lat, lng) => [(lng - west) * scale * cos, (north - lat) * scale];
  const node = (i) => project(osm.nodes[2 * i] / 1e5, osm.nodes[2 * i + 1] / 1e5);
  const inView = ([x, y]) => x > -100 && x < WIDTH + 100 && y > -100 && y < HEIGHT + 100;
  const path = (points, close = false) =>
    simplify(points, 1.2)
      .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join("") + (close ? "Z" : "");

  const visible = (nodes) => nodes.map(node).filter(inView).length > 0;
  const areas = { green: "", water: "" };
  for (const [kind, nodes] of osm.areas) {
    if (visible(nodes)) areas[kind ? "water" : "green"] += path(nodes.map(node), true);
  }
  const byClass = ROAD_WIDTHS.map(() => "");
  for (const [cls, , nodes] of osm.roads) {
    if (visible(nodes)) byClass[cls] += path(nodes.map(node));
  }
  // Wide roads last, so they sit on top of the small ones they cross.
  const order = [4, 3, 2, 1, 0].filter((cls) => byClass[cls]);
  const road = (cls, casing) => {
    const trunk = cls === 0;
    const stroke = casing ? (trunk ? "#E2C882" : "#CDD5CE") : trunk ? "#FFEFC2" : "#FFFFFF";
    const width = ROAD_WIDTHS[cls] + (casing ? 2 : 0);
    return `<path d="${byClass[cls]}" stroke="${stroke}" stroke-width="${width}"/>`;
  };

  const dots = zones
    .map((z, i) => {
      const [x, y] = project(z.latitude, z.longitude).map((v) => v.toFixed(1));
      return `<g transform="translate(${x} ${y})"><circle r="25" fill="#19743C" stroke="#FFFFFF" stroke-width="5"/><text y="8">${i + 1}</text></g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
<title>Map of the University of Ghana, Legon, with CampusRide's ${zones.length} pickup areas numbered</title>
<rect width="${WIDTH}" height="${HEIGHT}" fill="#EBF0EC"/>
<path d="${areas.green}" fill="#CFE8D6"/><path d="${areas.water}" fill="#CFE3F2"/>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">${order.map((c) => road(c, true)).join("")}${order.map((c) => road(c, false)).join("")}</g>
<g font-family="Figtree, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" font-size="23" font-weight="800" fill="#FFFFFF" text-anchor="middle">${dots}</g>
<g font-family="-apple-system, 'Segoe UI', Roboto, Arial, sans-serif" font-size="15" fill="#5B6662"><rect x="${WIDTH - 232}" y="${HEIGHT - 30}" width="232" height="30" fill="#FFFFFF" fill-opacity="0.8"/><text x="${WIDTH - 12}" y="${HEIGHT - 10}" text-anchor="end">Map data © OpenStreetMap contributors</text></g>
</svg>
`;
}

// ─── The welcome animation ───────────────────────────────────────────────────

/**
 * The apps' welcome animation for the hero, as files for dist/welcome/. Its
 * one embedded picture (a data: URI) becomes a file next to it, so the page
 * needs no `data:` in its Content-Security-Policy.
 */
export function welcomeAnimation(root = repoRoot) {
  const animation = JSON.parse(readSource(root, "packages/mobile-shared/assets/welcome/welcome.json"));
  const files = {};
  for (const asset of animation.assets ?? []) {
    const match = asset.p?.match(/^data:image\/(png|jpeg);base64,(.*)$/);
    if (!match) continue;
    const name = `${asset.id}.${match[1] === "jpeg" ? "jpg" : "png"}`;
    files[name] = Buffer.from(match[2], "base64");
    // lottie-web looks for it next to welcome.json (it prefixes the JSON's folder).
    Object.assign(asset, { u: "", p: name, e: 0 });
  }
  files["welcome.json"] = JSON.stringify(animation);
  return files;
}

// ─── Phones, badges, structured data ─────────────────────────────────────────

/**
 * The app screenshots: src/screens.json lists them (and the prices they were
 * made with); tools/screenshots.py renders them into public/screens/.
 */
export function readScreens() {
  return JSON.parse(readFileSync(join(here, "src/screens.json"), "utf8"));
}

/** The widths each screenshot is saved at (tools/screenshots.py), for srcset. */
const SCREEN_WIDTHS = [320, 640];

/** A WebP file's pixel size, from its header (lossy, lossless or extended), or null. */
export function webpSize(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return null;
}

/**
 * Every phone frame's picture, checked before anything is written: each
 * screenshot in src/screens.json must exist at every width, be a WebP of a
 * 390 x 844 phone screen, and have something in it (a blank screen compresses
 * to almost nothing). A missing or broken one fails the build rather than
 * shipping an empty phone.
 */
export function checkScreens(screens, dir = join(here, "public", "screens")) {
  const fix = "run python3 apps/web/tools/screenshots.py";
  for (const { name } of screens) {
    for (const width of SCREEN_WIDTHS) {
      const file = join(dir, `${name}-${width}.webp`);
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch {
        throw new Error(`Missing app screenshot public/screens/${name}-${width}.webp: ${fix}`);
      }
      const size = webpSize(bytes);
      if (!size || size.width !== width || Math.abs(size.height / size.width - 844 / 390) > 0.01) {
        throw new Error(`public/screens/${name}-${width}.webp isn't a ${width} px wide phone screenshot: ${fix}`);
      }
      // Real screens are 5 KB and up at 320 px; an empty white one is under 1 KB.
      if (bytes.length < 2048) throw new Error(`public/screens/${name}-${width}.webp looks blank: ${fix}`);
    }
  }
}

/** Signal, Wi-Fi and battery, as an iPhone's status bar draws them. */
const STATUS_ICONS = `<svg viewBox="0 0 68 12" width="68" height="12" aria-hidden="true" focusable="false"><g fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="4.5" y="6" width="3" height="6" rx="1"/><rect x="9" y="3.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="1" width="3" height="11" rx="1"/><path d="M29 2.2c2.3 0 4.4.9 6 2.4l1.2-1.2A10 10 0 0 0 29 .5a10 10 0 0 0-7.2 2.9L23 4.6a8.3 8.3 0 0 1 6-2.4Zm0 3.3c1.4 0 2.7.5 3.6 1.4l1.2-1.2A6.8 6.8 0 0 0 29 3.8c-1.9 0-3.6.7-4.8 1.9l1.2 1.2c1-.9 2.2-1.4 3.6-1.4Zm0 3.3c-.6 0-1.1.2-1.4.6L29 11l1.4-1.6c-.3-.4-.8-.6-1.4-.6Z"/><rect x="42.5" y="1" width="21" height="10" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.45"/><rect x="44.5" y="3" width="17" height="6" rx="1.6"/><path d="M65 4.2c.8.3 1.3.9 1.3 1.8s-.5 1.5-1.3 1.8Z" fill-opacity="0.5"/></g></svg>`;

/**
 * One screenshot in an iPhone frame. `size` is its width on the page (for
 * srcset), `eager` for the pictures in the first screen of the home page.
 */
function phone(screen, { size = 260, eager = false, extra = "" } = {}) {
  const src = (w) => `/screens/${screen.name}-${w}.webp`;
  const srcset = SCREEN_WIDTHS.map((w) => `${src(w)} ${w}w`).join(", ");
  const loading = eager ? 'fetchpriority="high"' : 'loading="lazy"';
  return `<div class="phone">
  <div class="phone-screen">
    <img src="${src(SCREEN_WIDTHS[0])}" srcset="${srcset}" sizes="${size}px" width="390" height="844" alt="${escapeHtml(screen.alt)}" ${loading} decoding="async" />${extra}
    <div class="phone-status phone-status-${screen.status}" aria-hidden="true"><span>9:41</span>${STATUS_ICONS}</div>
  </div>
</div>`;
}

/**
 * Store links for one app. Apple and Google allow their badges only for apps
 * people can download, so while a store's link in site.config is empty the
 * page says "Coming soon" in plain text instead; with a link, its official
 * badge shows, linked to the listing.
 */
export function storeButtons(links, appName) {
  const live = [];
  if (links.appStore) {
    live.push(
      `<a class="store-badge" href="${escapeHtml(links.appStore)}"><img src="/badges/app-store.svg" width="120" height="40" alt="Download ${escapeHtml(appName)} on the App Store" /></a>`,
    );
  }
  if (links.googlePlay) {
    live.push(
      `<a class="store-badge" href="${escapeHtml(links.googlePlay)}"><img src="/badges/google-play.png" width="134" height="40" alt="Get ${escapeHtml(appName)} on Google Play" /></a>`,
    );
  }
  const soon = [!links.appStore && "the App Store", !links.googlePlay && "Google Play"].filter(Boolean);
  const note = soon.length
    ? `<p class="store-soon"><span class="store-soon-dot" aria-hidden="true"></span>Coming soon to ${soon.join(" and ")}</p>`
    : "";
  return `<div class="stores">${live.join("")}${note}</div>`;
}

/** schema.org Organization, for search engines. */
function jsonLd(config) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: config.name,
    url: pageUrl("", config.url),
    logo: `${config.url}/brand/icon-512.png`,
    email: config.supportEmail,
    description:
      "A ride app for students and staff around the University of Ghana, Legon: shared and private rides at fixed fares, paid in cash.",
    founder: { "@type": "Person", name: config.operatorName },
    areaServed: { "@type": "Place", name: "University of Ghana, Legon, Accra, Ghana" },
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: config.supportEmail,
      telephone: config.supportPhone?.replace(/[^+\d]/g, ""),
      availableLanguage: "en",
    },
  };
  // "<" escaped so nothing in the data can close the script element.
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

export function pageUrl(slug, base = site.url) {
  return slug ? `${base}/${slug}` : `${base}/`;
}

/** The `{{name}}` values pages may use. HTML strings, already escaped. */
function values(config) {
  const plain = (key) =>
    config[key] == null || config[key] === ""
      ? `<span class="placeholder">[${PLACEHOLDER_LABELS[key]}]</span>`
      : escapeHtml(config[key]);
  const phoneHref = config.supportPhone ? config.supportPhone.replace(/[^+\d]/g, "") : null;
  const { pricing, zones, screens } = config;
  const screen = (name) => {
    const found = screens.screens.find((s) => s.name === name);
    if (!found) throw new Error(`No screenshot "${name}" in src/screens.json`);
    return found;
  };
  const anyBadge = [config.stores.rider, config.stores.driver].some((s) => s.appStore || s.googlePlay);
  return {
    siteName: escapeHtml(config.name),
    operatorName: plain("operatorName"),
    operatorAddress: plain("operatorAddress"),
    supportPhone: plain("supportPhone"),
    supportPhoneLink: phoneHref
      ? `<a href="tel:${phoneHref}">${escapeHtml(config.supportPhone)}</a>`
      : plain("supportPhone"),
    supportEmail: escapeHtml(config.supportEmail),
    supportEmailLink: `<a href="mailto:${escapeHtml(config.supportEmail)}">${escapeHtml(config.supportEmail)}</a>`,
    deleteEmailLink: `<a href="mailto:${escapeHtml(config.supportEmail)}?subject=Delete%20my%20account">${escapeHtml(config.supportEmail)}</a>`,
    legalLastUpdated: escapeHtml(config.legalLastUpdated),
    emailDeletionDays: String(config.emailDeletionDays),
    retentionDays: String(config.retentionDays),
    year: String(config.year),

    sharedFare: formatCedis(pricing.sharedFare),
    loneFare: formatCedis(pricing.loneFare),
    maxSharedRiders: String(pricing.maxSharedRiders),
    driverSharePct: String(100 - pricing.commissionPct),
    commissionPct: String(pricing.commissionPct),
    driverShareOfLoneFare: formatCedis(pricing.loneFare - Math.round((pricing.loneFare * pricing.commissionPct) / 100)),

    zoneCount: String(zones.length),
    zoneList: zones.map((z) => `<li>${escapeHtml(z.name)}</li>`).join("\n        "),

    riderStores: storeButtons(config.stores.rider, "CampusRide"),
    driverStores: storeButtons(config.stores.driver, "CampusRide Driver"),
    storeTrademarks: anyBadge
      ? "<p>App Store is a service mark of Apple Inc. Google Play and the Google Play logo are trademarks of Google LLC.</p>"
      : "",

    phoneWelcome: phone(screen("welcome"), {
      size: 300,
      eager: true,
      extra: `\n    <div class="phone-anim" data-welcome="/welcome/welcome.json" aria-hidden="true"><div class="phone-anim-art"></div></div>`,
    }),
    phoneHome: phone(screen("home"), { size: 260, eager: true }),
    phonePlan: phone(screen("plan")),
    phoneChoose: phone(screen("choose")),
    phoneDriverComing: phone(screen("driver-coming")),
    phoneSafety: phone(screen("safety"), { size: 280 }),
    phoneDriverOffer: phone(screen("driver-offer"), { size: 280 }),
  };
}

/** Replaces every `{{name}}`; an unknown name fails the build rather than shipping braces. */
function fill(template, vars, where) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Unknown {{${key}}} in ${where}`);
    return vars[key];
  });
}

/** The header's links. On the home page, its own sections are plain #anchors. */
function nav(currentSlug) {
  return NAV.map(({ href, label }) => {
    const target = currentSlug === "" && href.startsWith("/#") ? href.slice(1) : href;
    const current = href === `/${currentSlug}` ? ' aria-current="page"' : "";
    return `<a href="${target}"${current}>${label}</a>`;
  }).join("\n            ");
}

const DRAFT_BANNER = `<div class="draft-banner" role="note"><strong>DRAFT FOR LEGAL REVIEW.</strong> This document has not yet been reviewed by a lawyer and may change.</div>`;

/** One page's complete HTML. */
export function renderPage(page, { layout, body, config }) {
  const vars = values(config);
  const isNotFound = page.slug === "404";
  const isHome = page.slug === "";
  const head = {
    title: escapeHtml(page.title),
    description: escapeHtml(fill(page.description, vars, `the ${page.slug || "home"} page's description`)),
    canonical: pageUrl(page.slug, config.url),
    ogImage: `${config.url}/og-image.png`,
    robots: isNotFound ? "noindex" : "index, follow",
    // The home page alone has the animation's script and the Organization data.
    pageHead: isHome ? `${jsonLd(config)}\n    <script src="/app.js" defer></script>` : "",
    bodyClass: isHome ? "home" : "inner",
  };
  return fill(
    layout,
    {
      ...vars,
      ...head,
      nav: nav(page.slug),
      draftBanner: config.draftPages.includes(page.slug) ? DRAFT_BANNER : "",
      content: fill(body, vars, `src/pages/${page.slug || "index"}.html`),
    },
    "src/layout.html",
  );
}

export function sitemap(config = site) {
  const urls = pages
    .map((p) => `  <url><loc>${pageUrl(p.slug, config.url)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robots(config = site) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${config.url}/sitemap.xml\n`;
}

/** The web app manifest (home-screen name and icons). */
function manifest(config) {
  return `${JSON.stringify(
    {
      name: config.name,
      short_name: config.name,
      start_url: "/",
      display: "browser",
      background_color: "#FFFFFF",
      theme_color: "#19743C",
      icons: [
        { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    },
    null,
    2,
  )}\n`;
}

/** Writes the whole site to `outDir`. Returns the paths written, relative to it. */
export function build(outDir = join(here, "dist")) {
  const zones = readZones();
  const config = {
    ...site,
    legalLastUpdated: readTermsDate(),
    retentionDays: readRetentionDays(),
    pricing: readPricing(),
    zones,
    screens: readScreens(),
    year: new Date().getFullYear(),
  };
  checkScreens(config.screens.screens);
  const layout = readFileSync(join(here, "src/layout.html"), "utf8");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(here, "public"), outDir, { recursive: true });

  const written = [];
  const write = (path, contents) => {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), contents);
    written.push(path);
  };

  const notFound = {
    slug: "404",
    title: "Page not found | CampusRide",
    description: "This page doesn't exist.",
  };
  for (const page of [...pages, notFound]) {
    const body = readFileSync(join(here, "src/pages", `${page.slug || "index"}.html`), "utf8");
    const html = renderPage(page, { layout, body, config });
    if (!page.slug) {
      write("index.html", html);
    } else {
      // Both spellings, so /privacy works whether the host maps it to
      // privacy.html or to privacy/index.html. The canonical link names one.
      write(`${page.slug}.html`, html);
      if (page.slug !== "404") write(`${page.slug}/index.html`, html);
    }
  }
  for (const [name, contents] of Object.entries(welcomeAnimation())) write(`welcome/${name}`, contents);
  write("where.svg", whereMap(zones));
  write("site.webmanifest", manifest(config));
  write("sitemap.xml", sitemap(config));
  write("robots.txt", robots(config));
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = build();
  process.stdout.write(`Built ${written.length} files into apps/web/dist\n`);
}
