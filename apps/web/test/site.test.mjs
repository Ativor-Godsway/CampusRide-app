/**
 * The website build: every page has its SEO basics, links resolve, the draft
 * banners are where site.config says, and the account-deletion page says what
 * the deletion code actually does. Node's own test runner, so the website
 * needs no dependencies: `npm test --workspace=apps/web`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { build, pages, pageUrl, readRetentionDays } from "../build.mjs";
import { site } from "../site.config.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const repoFile = (path) => readFileSync(join(repo, path), "utf8");

let out;
const read = (path) => readFileSync(join(out, path), "utf8");
const pageFile = (slug) => (slug ? `${slug}.html` : "index.html");
const meta = (html, attr, key) =>
  html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];

before(() => {
  out = mkdtempSync(join(tmpdir(), "campusride-web-"));
  build(out);
});

after(() => rmSync(out, { recursive: true, force: true }));

describe("website build", () => {
  it("writes every page, under both URL spellings, and a 404 page", () => {
    for (const { slug } of pages) {
      assert.ok(existsSync(join(out, pageFile(slug))), pageFile(slug));
      if (slug) assert.ok(existsSync(join(out, slug, "index.html")), `${slug}/index.html`);
    }
    assert.ok(existsSync(join(out, "404.html")));
  });

  it("leaves no unfilled {{placeholders}}", () => {
    for (const { slug } of pages) assert.doesNotMatch(read(pageFile(slug)), /\{\{|\}\}/);
  });

  it("gives every page a title, description, canonical link and Open Graph tags", () => {
    for (const { slug, title, description } of pages) {
      const html = read(pageFile(slug));
      const url = pageUrl(slug);
      assert.ok(html.includes(`<title>${title}</title>`), `${slug || "home"}: title`);
      assert.ok(
        description.length >= 50 && description.length <= 200,
        `${slug}: description length`,
      );
      assert.ok(meta(html, "name", "description"));
      assert.ok(html.includes(`<link rel="canonical" href="${url}" />`), `${slug}: canonical`);
      assert.equal(meta(html, "property", "og:url"), url);
      assert.ok(meta(html, "property", "og:title"));
      assert.ok(meta(html, "property", "og:description"));
      assert.equal(meta(html, "property", "og:image"), `${site.url}/og-image.png`);
      assert.equal(meta(html, "name", "twitter:card"), "summary_large_image");
      assert.equal(meta(html, "name", "robots"), "index, follow");
    }
    assert.equal(meta(read("404.html"), "name", "robots"), "noindex");
  });

  it("lists every page in sitemap.xml, and robots.txt points to it", () => {
    const sitemap = read("sitemap.xml");
    for (const { slug } of pages) assert.ok(sitemap.includes(`<loc>${pageUrl(slug)}</loc>`), slug);
    assert.ok(read("robots.txt").includes(`Sitemap: ${site.url}/sitemap.xml`));
  });

  it("has no broken internal links, assets or #anchors", () => {
    for (const { slug } of pages) {
      const html = read(pageFile(slug));
      for (const [, target] of html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
        const file = target === "/" ? "index.html" : target.slice(1);
        const asPage = `${file}.html`;
        assert.ok(
          existsSync(join(out, file)) || existsSync(join(out, asPage)),
          `${pageFile(slug)} links to missing ${target}`,
        );
      }
      for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) {
        assert.ok(html.includes(`id="${anchor}"`), `${pageFile(slug)} is missing #${anchor}`);
      }
      for (const [, page, anchor] of html.matchAll(/href="\/([a-z-]+)#([^"]+)"/g)) {
        assert.ok(read(`${page}.html`).includes(`id="${anchor}"`), `/${page}#${anchor}`);
      }
    }
    assert.ok(existsSync(join(out, "og-image.png")));
  });

  it("marks exactly the pages in site.draftPages as DRAFT FOR LEGAL REVIEW", () => {
    assert.deepEqual(site.draftPages, ["privacy", "terms"]);
    for (const { slug } of pages) {
      const hasBanner = read(pageFile(slug)).includes("DRAFT FOR LEGAL REVIEW");
      assert.equal(hasBanner, site.draftPages.includes(slug), slug || "home");
    }
  });

  it("shows operator details that aren't filled in yet as visible placeholders", () => {
    const privacy = read("privacy.html");
    if (site.operatorName == null) {
      assert.ok(privacy.includes(`<span class="placeholder">[OPERATOR'S FULL LEGAL NAME]</span>`));
    }
    if (site.operatorAddress == null) {
      assert.ok(privacy.includes(`<span class="placeholder">[OPERATOR'S POSTAL ADDRESS]</span>`));
    }
  });
});

describe("the website matches the code", () => {
  it("reads the account-deletion retention period from @rida/shared", () => {
    const days = readRetentionDays();
    assert.ok(Number.isInteger(days) && days > 0);
    assert.ok(read("delete-account.html").includes(`Kept for ${days} days, then erased`));
    assert.ok(read("privacy.html").includes(`<strong>${days} days</strong>`));
  });

  it("describes the in-app deletion flow with the app's own labels", () => {
    const screen = repoFile("packages/mobile-shared/src/auth/screens/DeleteAccountScreen.tsx");
    const html = read("delete-account.html");
    for (const label of ["Delete account", "Send me a code to confirm", "Delete my account"]) {
      assert.ok(screen.includes(label), `app no longer says "${label}"`);
      assert.ok(html.includes(`<strong>${label}</strong>`), `page doesn't say "${label}"`);
    }
  });

  it("lists what the deletion code really erases after the retention period", () => {
    const code = repoFile("apps/server/src/services/auth/deleteAccount.ts");
    // What purgeDeletedAccounts clears, and the words the page uses for it.
    for (const field of ["pickupNote", "riderCancelNote", "comment: null", "destroyPhoto"]) {
      assert.ok(code.includes(field), `purgeDeletedAccounts no longer clears ${field}`);
    }
    const html = read("delete-account.html");
    for (const words of [
      "pickup notes",
      "cancellation notes",
      "comments you left on ratings",
      "photo on our photo host",
    ]) {
      assert.ok(html.includes(words), words);
    }
  });

  it("gives the no-app deletion route by email", () => {
    const html = read("delete-account.html");
    assert.ok(html.includes(`mailto:${site.supportEmail}?subject=Delete%20my%20account`));
    assert.match(html, new RegExp(`within\\s+<strong>${site.emailDeletionDays} days</strong>`));
  });

  it("describes background location only for the driver app, as configured", () => {
    const rider = JSON.parse(repoFile("apps/rider/app.json")).expo.plugins;
    const driver = JSON.parse(repoFile("apps/driver/app.json")).expo.plugins;
    const locationOf = (plugins) =>
      plugins.find((p) => Array.isArray(p) && p[0] === "expo-location")[1];
    assert.equal(locationOf(rider).isAndroidBackgroundLocationEnabled, false);
    assert.equal(locationOf(driver).isAndroidBackgroundLocationEnabled, true);
    const privacy = read("privacy.html");
    assert.ok(privacy.includes("The rider app never uses location in the background."));
    assert.match(privacy, /even when the app is closed or not\s+in use/);
  });
});
