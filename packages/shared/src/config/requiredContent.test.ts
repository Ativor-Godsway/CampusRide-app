/// <reference types="node" />
/**
 * What the store rules, safety and the law need the apps and the website to
 * keep, pinned so a wording or layout clean-up can't drop it by accident:
 * account deletion, the privacy policy and terms, the 18+ confirmation,
 * the Safety/SOS features, the permission explanations, the cash fare, the
 * launch countdown, Call support and the licences notice.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe.each(["rider", "driver"])("the %s app keeps", (app) => {
  const account = read(`apps/${app}/app/(tabs)/account.tsx`);

  it("Delete account, its screen, Terms and Privacy in Account", () => {
    expect(account).toContain('title="Delete account"');
    expect(account).toContain('router.push("/delete-account")');
    expect(read(`apps/${app}/app/delete-account.tsx`)).toContain("DeleteAccountScreen");
    expect(account).toContain("openLegalPage(TERMS_URL)");
    expect(account).toContain("openLegalPage(PRIVACY_URL)");
  });

  it("one Call support row, and the licences notice with the version under About", () => {
    expect(account.match(/<CallSupportRow/g)).toHaveLength(1);
    expect(account).not.toContain("Help and support");
    expect(account).toContain('router.push("/licenses")');
    expect(account).toContain("getAppVersionLabel()");
    expect(read(`apps/${app}/app/licenses.tsx`)).toContain("OpenSourceLicensesScreen");
  });

  it("the notification explanation before the system prompt", () => {
    expect(read(`apps/${app}/app/notifications.tsx`)).toContain("NotificationPermissionScreen");
    expect(read(`apps/${app}/app/(tabs)/_layout.tsx`)).toContain("usePushPermissionPrompt");
  });

  it("the 18+ and terms confirmation", () => {
    expect(read(`apps/${app}/app/_layout.tsx`)).toContain("TermsConfirmationGate");
    expect(read("packages/mobile-shared/src/auth/screens/TermsConfirmation.tsx")).toContain("18 or older");
  });
});

describe("the rider app keeps", () => {
  it("Safety: the emergency contact alert, 112, and the screen to set a contact", () => {
    const sheet = read("apps/rider/components/ride/SafetySheet.tsx");
    expect(sheet).toContain("Alert my emergency contact");
    expect(sheet).toContain("EMERGENCY_NUMBER");
    expect(read("apps/rider/app/(tabs)/account.tsx")).toContain('router.push("/safety")');
  });

  it("the cash fare before booking, and the launch countdown on Home", () => {
    const type = read("apps/rider/app/ride/type.tsx");
    expect(type).toContain('label="Cash"');
    expect(type).toContain("paid in cash");
    expect(read("apps/rider/app/(tabs)/index.tsx")).toContain("<LaunchCountdownCard");
  });

  it("the location explanation", () => {
    expect(read("apps/rider/app/(tabs)/index.tsx")).toContain("Turn on location to set your pickup.");
  });
});

describe("the driver app keeps", () => {
  it("the location disclosure before the system prompt", () => {
    expect(read("apps/driver/app/_layout.tsx")).toContain("LocationDisclosureProvider");
    expect(read("packages/shared/src/driver/locationAccess.ts")).toContain("even when the app is closed or not in use");
  });

  it("the launch countdown on Home, and why location is shared while online", () => {
    const home = read("apps/driver/app/(tabs)/index.tsx");
    expect(home).toContain("<LaunchBanner");
    expect(home).toContain("Your location is shared only");
  });
});

describe("the website keeps", () => {
  it.each(["privacy", "terms", "delete-account", "support"])("its %s page", (page) => {
    expect(existsSync(path.join(ROOT, `apps/web/src/pages/${page}.html`))).toBe(true);
  });

  it("the support phone and 112 on the Support page", () => {
    const support = read("apps/web/src/pages/support.html");
    expect(support).toContain("{{supportPhoneLink}}");
    expect(support).toContain("call 112");
    expect(read("apps/web/site.config.mjs")).toContain('supportPhone: "+233 54 860 8146"');
  });
});
