/**
 * The website build: every page has its SEO basics, links resolve, the draft
 * banners are where site.config says, and the account-deletion page says what
 * the deletion code actually does. Node's own test runner, so the website
 * needs no dependencies: `npm test --workspace=apps/web`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  build,
  formatCedis,
  pages,
  pageUrl,
  readPricing,
  readRetentionDays,
  readScreens,
  readTermsDate,
  readZones,
  storeButtons,
} from "../build.mjs";
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
    for (const { slug } of pages) assert.doesNotMatch(read(pageFile(slug)), /\{\{\s*\w*\s*\}\}/);
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
      for (const [, page, anchor] of html.matchAll(/href="\/([a-z-]*)#([^"]+)"/g)) {
        assert.ok(read(pageFile(page)).includes(`id="${anchor}"`), `/${page}#${anchor}`);
      }
      for (const [, set] of html.matchAll(/srcset="([^"]+)"/g)) {
        for (const candidate of set.split(",")) {
          const path = candidate.trim().split(" ")[0];
          assert.ok(existsSync(join(out, path.slice(1))), `${pageFile(slug)} srcset has missing ${path}`);
        }
      }
    }
    assert.ok(existsSync(join(out, "og-image.png")));
  });

  it("works under the site's Content-Security-Policy: no inline styles or scripts", () => {
    for (const slug of [...pages.map((p) => p.slug), "404"]) {
      const html = read(pageFile(slug));
      assert.doesNotMatch(html, /\sstyle="/, `${pageFile(slug)} has a style attribute`);
      assert.doesNotMatch(html, /<style/, `${pageFile(slug)} has a <style> element`);
      for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
        // Only same-site files run; JSON-LD is data, which CSP doesn't block.
        assert.match(tag, /src="\/[^"]+"|type="application\/ld\+json"/, `${pageFile(slug)}: ${tag}`);
      }
      assert.doesNotMatch(html, /\son[a-z]+="/, `${pageFile(slug)} has an inline event handler`);
      assert.doesNotMatch(html, /(?:src|href)="https?:\/\/(?!campusride\.app)[^"]*\.(?:js|css|woff2?)"/);
    }
    // The animation's picture is a file, not a data: URI (img-src is 'self' only).
    const animation = read("welcome/welcome.json");
    assert.doesNotMatch(animation, /"p":"data:/);
    for (const asset of JSON.parse(animation).assets.filter((a) => a.p)) {
      assert.ok(existsSync(join(out, "welcome", asset.u + asset.p)), asset.p);
    }
    // render.yaml lists the headers; the site needs these allowances.
    const web = repoFile("render.yaml").split("name: campusride-web")[1] ?? "";
    const csp = web.match(/name: Content-Security-Policy\n\s+value: "([^"]+)"/)?.[1];
    assert.ok(csp, "no Content-Security-Policy in render.yaml");
    for (const rule of ["default-src 'none'", "script-src 'self'", "font-src 'self'", "connect-src 'self'", "img-src 'self'"]) {
      assert.ok(csp.includes(rule), `CSP lacks ${rule}`);
    }
    assert.ok(repoFile("docs/runbooks/website.md").includes(csp), "the runbook's CSP differs from render.yaml's");
  });

  it("gives every picture alt text, and sizes so nothing jumps while loading", () => {
    for (const slug of [...pages.map((p) => p.slug), "404"]) {
      for (const [tag] of read(pageFile(slug)).matchAll(/<img\b[^>]*>/g)) {
        assert.match(tag, /\salt="[^"]+"/, `${pageFile(slug)}: ${tag}`);
        assert.match(tag, /\swidth="\d+" height="\d+"|\sheight="\d+"[^>]*\swidth="\d+"/, tag);
      }
    }
  });

  it("describes the organisation for search engines (JSON-LD)", () => {
    const json = read("index.html").match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1];
    assert.ok(json, "no JSON-LD on the home page");
    const data = JSON.parse(json);
    assert.equal(data["@type"], "Organization");
    assert.equal(data.name, site.name);
    assert.equal(data.url, `${site.url}/`);
    assert.equal(data.email, site.supportEmail);
    assert.ok(existsSync(join(out, new URL(data.logo).pathname.slice(1))), data.logo);
  });

  it("says who runs CampusRide, and that it isn't the University's, on every page", () => {
    for (const slug of [...pages.map((p) => p.slug), "404"]) {
      const html = read(pageFile(slug));
      assert.ok(html.includes(`CampusRide, operated by ${site.operatorName}, Ghana.`), slug || "home");
      assert.ok(
        html.includes("CampusRide is independent and is not affiliated with or endorsed by the University of Ghana."),
        slug || "home",
      );
      assert.ok(html.includes(site.supportEmail), slug || "home");
    }
  });

  it("shows no DRAFT FOR LEGAL REVIEW banner (the owner turned them off)", () => {
    assert.deepEqual(site.draftPages, []);
    for (const { slug } of pages) {
      assert.ok(!read(pageFile(slug)).includes("DRAFT FOR LEGAL REVIEW"), slug || "home");
    }
  });

  it("has every operator detail filled in: no [PLACEHOLDER] on any page", () => {
    for (const key of ["operatorName", "operatorAddress", "supportPhone"]) {
      assert.ok(typeof site[key] === "string" && site[key].trim(), `site.${key} is empty`);
    }
    for (const { slug } of pages) {
      const html = read(pageFile(slug));
      assert.ok(!html.includes('class="placeholder"'), `${slug || "home"} still shows a placeholder`);
    }
    assert.ok(!read("404.html").includes('class="placeholder"'), "404 still shows a placeholder");
  });

  it("names the operator and how to reach them on the legal pages", () => {
    const privacy = read("privacy.html");
    const terms = read("terms.html");
    for (const html of [privacy, terms]) {
      assert.ok(html.includes(site.operatorName));
      assert.ok(html.includes(`${site.operatorAddress}, Ghana`));
      assert.ok(html.includes(`<a href="tel:+233548608146">${site.supportPhone}</a>`));
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

  it("dates the privacy policy and terms with TERMS_VERSION, the version the apps record", () => {
    const version = repoFile("packages/shared/src/account/terms.ts").match(
      /TERMS_VERSION = "(\d{4}-\d{2}-\d{2})"/,
    )?.[1];
    assert.ok(version, "TERMS_VERSION not found");
    const date = readTermsDate();
    assert.equal(new Date(`${date} UTC`).toISOString().slice(0, 10), version);
    for (const page of ["privacy.html", "terms.html"]) {
      assert.ok(read(page).includes(`Last updated: ${date}`), page);
    }
  });

  it("says sign-up asks for the same 18+ and terms confirmation the apps show", () => {
    const checkbox = repoFile("packages/mobile-shared/src/auth/screens/TermsConfirmation.tsx");
    assert.ok(checkbox.includes("I&apos;m 18 or older and I agree to the"));
    assert.ok(checkbox.includes("TERMS_URL") && checkbox.includes("PRIVACY_URL"));
    const shared = repoFile("packages/shared/src/account/terms.ts");
    assert.ok(shared.includes(`"${site.url}/terms"`) && shared.includes(`"${site.url}/privacy"`));
    assert.match(read("terms.html"), /When you sign up, you confirm this/);
    assert.match(read("privacy.html"), /confirmation that you're 18 or older/);
    assert.match(read("privacy.html"), /Everyone confirms they're 18 or over when they sign up/);
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

describe("the home page matches the code", () => {
  const pricing = readPricing();
  const home = () => read("index.html");

  it("shows today's fares and commission from @rida/shared's PRICING", () => {
    const shared = formatCedis(pricing.sharedFare);
    const lone = formatCedis(pricing.loneFare);
    const driverShare = formatCedis(pricing.loneFare - Math.round((pricing.loneFare * pricing.commissionPct) / 100));
    assert.ok(home().includes(`<span class="price-amount">${shared}</span> <span class="price-unit">per rider</span>`));
    assert.ok(home().includes(`<span class="price-amount">${lone}</span>`));
    assert.ok(home().includes(`Keep ${100 - pricing.commissionPct}% of every fare`));
    assert.ok(read("support.html").includes(`${shared} per rider for a shared ride, ${lone} to ride alone`));
    // Any amount on the pages is one of today's: an old fare can't linger in the copy.
    for (const page of ["index.html", "support.html"]) {
      for (const [amount] of read(page).matchAll(/GH₵\d+(?:\.\d{2})?/g)) {
        assert.ok([shared, lone, driverShare].includes(amount), `${page} shows ${amount}`);
      }
    }
  });

  it("formats cedis as the apps do", () => {
    assert.equal(formatCedis(700), "GH₵7");
    assert.equal(formatCedis(1275), "GH₵12.75");
    assert.equal(formatCedis(1050), "GH₵10.50");
  });

  it("refuses to build if shared fares stop being one fare per rider", () => {
    const root = mkdtempSync(join(tmpdir(), "campusride-pricing-"));
    try {
      const dir = join(root, "packages/shared/src/pricing");
      mkdirSync(dir, { recursive: true });
      const real = repoFile("packages/shared/src/pricing/pricing.ts");
      writeFileSync(join(dir, "pricing.ts"), real.replace(/SHARED_FARES: \{[^}]*\}/, "SHARED_FARES: { 1: 700, 2: 600, 3: 600, 4: 500 }"));
      assert.throws(() => readPricing(root), /no longer the same for every rider count/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses screenshots made at today's prices (else: python3 apps/web/tools/screenshots.py)", () => {
    const { screens, madeWith } = readScreens();
    assert.ok(madeWith, "src/screens.json has no madeWith: run apps/web/tools/screenshots.py");
    const { date: _date, ...prices } = madeWith;
    assert.deepEqual(prices, pricing, "the app screenshots show other prices: run apps/web/tools/screenshots.py");
    for (const { name, alt } of screens) {
      assert.ok(alt.length > 20, `${name} needs real alt text`);
      for (const width of [320, 640]) assert.ok(existsSync(join(out, "screens", `${name}-${width}.webp`)), name);
    }
  });

  it("lists the zones in service, and not the retired ones", () => {
    const zones = readZones();
    const source = repoFile("apps/server/src/scripts/realignZones.ts");
    assert.ok(zones.length >= 10);
    for (const { name } of zones) assert.ok(home().includes(`<li>${name.replace(/&/g, "&amp;")}</li>`), name);
    assert.ok(source.includes('RETIRED_ZONES = ["Accra Mall Junction"]'));
    assert.ok(!home().includes("Accra Mall"));
    assert.ok(home().includes(`these ${zones.length} areas`));
    const map = read("where.svg");
    assert.equal([...map.matchAll(/<circle /g)].length, zones.length);
    assert.ok(map.includes("OpenStreetMap contributors"));
  });

  it("says Coming soon until a store link is set, then shows that store's official badge", () => {
    for (const app of ["rider", "driver"]) {
      for (const store of ["appStore", "googlePlay"]) {
        assert.equal(typeof site.stores[app][store], "string", `site.stores.${app}.${store}`);
      }
    }
    const none = storeButtons({ appStore: "", googlePlay: "" }, "CampusRide");
    assert.ok(none.includes("Coming soon to the App Store and Google Play"));
    assert.ok(!none.includes("<img"), "no store badge without a link (Apple's and Google's rules)");
    const one = storeButtons({ appStore: "", googlePlay: "https://play.google.com/store/apps/details?id=x" }, "CampusRide");
    assert.ok(one.includes('href="https://play.google.com/store/apps/details?id=x"'));
    assert.ok(one.includes('src="/badges/google-play.png"'));
    assert.ok(one.includes("Coming soon to the App Store"));
    assert.ok(!one.includes("Google Play</p>"));
    const both = storeButtons({ appStore: "https://apps.apple.com/app/id1", googlePlay: "https://play.google.com/x" }, "CampusRide");
    assert.ok(!both.includes("Coming soon"));
    // Apple: the App Store badge comes first.
    assert.ok(both.indexOf("app-store.svg") < both.indexOf("google-play.png"));
    for (const badge of ["badges/app-store.svg", "badges/google-play.png"]) assert.ok(existsSync(join(out, badge)));
  });
});
