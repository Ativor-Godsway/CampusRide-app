/**
 * Builds the CampusRide website (https://campusride.app) into dist/.
 *
 * No dependencies and no install step: Render runs `node apps/web/build.mjs`
 * and publishes apps/web/dist. Each page in src/pages is wrapped in
 * src/layout.html, `{{name}}` values are filled in from site.config.mjs, and
 * sitemap.xml and robots.txt are written from the page list below.
 *
 * The account-deletion retention period is read from @rida/shared's source
 * (the same constant the server and the apps use), so the website can't
 * promise a different number of days than the code keeps.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { site } from "./site.config.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Every page, in sitemap order. `slug` "" is the home page. */
export const pages = [
  {
    slug: "",
    title: "CampusRide: affordable rides around the University of Ghana",
    description:
      "CampusRide is a ride app for students and staff around the University of Ghana, Legon. Shared and private rides with fixed fares, paid in cash. Coming soon to Google Play.",
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

const NAV = [
  { slug: "", label: "Home" },
  { slug: "support", label: "Support" },
  { slug: "privacy", label: "Privacy" },
  { slug: "terms", label: "Terms" },
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** ACCOUNT_DELETION_RETENTION_DAYS from packages/shared/src/account/deletion.ts. */
export function readRetentionDays(root = join(here, "..", "..")) {
  const source = readFileSync(join(root, "packages/shared/src/account/deletion.ts"), "utf8");
  const match = source.match(/export const ACCOUNT_DELETION_RETENTION_DAYS = (\d+);/);
  if (!match) throw new Error("ACCOUNT_DELETION_RETENTION_DAYS not found in @rida/shared");
  return Number(match[1]);
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
  };
}

/** Replaces every `{{name}}`; an unknown name fails the build rather than shipping braces. */
function fill(template, vars, where) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Unknown {{${key}}} in ${where}`);
    return vars[key];
  });
}

function nav(currentSlug) {
  return NAV.map(({ slug, label }) => {
    const current = slug === currentSlug ? ' aria-current="page"' : "";
    return `<a href="/${slug}"${current}>${label}</a>`;
  }).join("\n          ");
}

const DRAFT_BANNER = `<div class="draft-banner" role="note"><strong>DRAFT FOR LEGAL REVIEW.</strong> This document has not yet been reviewed by a lawyer and may change.</div>`;

/** One page's complete HTML. */
export function renderPage(page, { layout, body, config }) {
  const vars = values(config);
  const isNotFound = page.slug === "404";
  const head = {
    title: escapeHtml(page.title),
    description: escapeHtml(page.description),
    canonical: pageUrl(page.slug, config.url),
    ogImage: `${config.url}/og-image.png`,
    robots: isNotFound ? "noindex" : "index, follow",
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

/** Writes the whole site to `outDir`. Returns the paths written, relative to it. */
export function build(outDir = join(here, "dist")) {
  const config = { ...site, retentionDays: readRetentionDays(), year: new Date().getFullYear() };
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
  write("sitemap.xml", sitemap(config));
  write("robots.txt", robots(config));
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = build();
  process.stdout.write(`Built ${written.length} files into apps/web/dist\n`);
}
