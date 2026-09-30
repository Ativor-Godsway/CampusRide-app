import { describe, expect, it } from "vitest";
import { isLocalDevServerUrl, resolveServerUrl } from "./serverUrl";

const PROD = "https://campusride-server-aaum.onrender.com";

describe("isLocalDevServerUrl", () => {
  it("recognises this machine and private-network addresses", () => {
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://192.168.1.23:3000",
      "http://10.0.0.5:3000",
      "http://172.20.10.2:3000",
      "http://my-mac.local:3000",
      "http://[::1]:3000",
    ]) {
      expect(isLocalDevServerUrl(url), url).toBe(true);
    }
  });

  it("does not flag public servers or junk", () => {
    for (const url of [PROD, "http://172.32.0.1:3000", "http://8.8.8.8", "not a url", ""]) {
      expect(isLocalDevServerUrl(url), url).toBe(false);
    }
  });
});

describe("resolveServerUrl", () => {
  it("uses the local server in a development build", () => {
    expect(resolveServerUrl({ envUrl: "http://192.168.1.23:3000", configUrl: PROD, isDev: true })).toBe(
      "http://192.168.1.23:3000",
    );
  });

  it("REFUSES a local server in a release build and uses production instead", () => {
    // The whole point: a Mac's Wi-Fi address can never ship to real users.
    expect(resolveServerUrl({ envUrl: "http://192.168.1.23:3000", configUrl: PROD, isDev: false })).toBe(PROD);
    expect(resolveServerUrl({ envUrl: "http://localhost:3000", configUrl: PROD, isDev: false })).toBe(PROD);
  });

  it("keeps a public env URL in a release build", () => {
    expect(resolveServerUrl({ envUrl: PROD, configUrl: undefined, isDev: false })).toBe(PROD);
  });

  it("falls back to app.json, then to localhost in development", () => {
    expect(resolveServerUrl({ envUrl: undefined, configUrl: PROD, isDev: true })).toBe(PROD);
    expect(resolveServerUrl({ envUrl: "  ", configUrl: undefined, isDev: true })).toBe("http://localhost:3000");
  });
});
