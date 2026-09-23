/**
 * Inbound deep-link validation.
 *
 * Both apps register a custom URL scheme (campusride-rider / campusride-driver),
 * which means ANY other app, web page or QR code on the device can launch
 * them with a URL of its choosing. Nothing validated those links: whatever
 * path arrived was handed to the router, so an attacker could deep-link a
 * user straight into an arbitrary screen with arbitrary route params.
 *
 * This is the allowlist. A link is honoured only when its scheme is exactly
 * ours and its path matches a route we deliberately expose; everything else
 * is dropped and the app opens normally at its own start screen.
 *
 * Pure and dependency-free so it can be unit tested; the React wiring lives
 * in mobile-shared (useDeepLinkGuard).
 */

/** A route param segment: ids and slugs only — no slashes, dots or encoded tricks. */
const PARAM_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Scheme grammar per RFC 3986. */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/)?([\s\S]*)$/;

export interface DeepLinkPolicy {
  /** The app's own scheme, without "://" (e.g. "campusride-rider"). */
  scheme: string;
  /**
   * Allowed route patterns, without a leading slash. A segment written as
   * ":name" matches exactly one PARAM_SEGMENT. "" is the app root.
   */
  allowedPaths: readonly string[];
}

/**
 * Extracts the routing path from a deep link, or null if the URL is
 * malformed or not ours.
 *
 * Note the custom-scheme quirk: in `campusride-rider://ride/abc` the segment
 * "ride" is parsed as the URL *authority*, not the path. Expo Router treats
 * the whole of it as the route, so authority and path are deliberately
 * rejoined here rather than dropping the first segment.
 */
export function parseDeepLinkPath(url: string, scheme: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;

  const match = SCHEME_RE.exec(url.trim());
  if (!match) return null;

  const [, urlScheme, , remainder] = match;
  if (urlScheme.toLowerCase() !== scheme.toLowerCase()) return null;

  // Drop query and fragment — they are not part of route matching.
  let path = remainder.split("?")[0].split("#")[0];

  // Reject anything carrying userinfo ("user@host"), which is the classic
  // way to make a hostile URL look like ours in a preview.
  if (path.includes("@")) return null;

  // A single decode pass, then a hard reject on anything still encoded:
  // double-encoding is how "%252e%252e" becomes ".." one layer later.
  try {
    const decoded = decodeURIComponent(path);
    if (decoded.includes("%")) return null;
    path = decoded;
  } catch {
    return null; // malformed percent-encoding
  }

  // Backslashes and control characters are never legitimate here, and
  // traversal has no meaning in a route name.
  // Matching control characters is the entire point here: they are exactly
  // what this check rejects.
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.includes("..")) return null;

  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Matches a concrete path against one allowlist pattern. */
function matchesPattern(path: string, pattern: string): boolean {
  const pathSegments = path === "" ? [] : path.split("/");
  const patternSegments = pattern === "" ? [] : pattern.split("/");

  if (pathSegments.length !== patternSegments.length) return false;

  return patternSegments.every((patternSegment, i) => {
    const segment = pathSegments[i];
    if (patternSegment.startsWith(":")) return PARAM_SEGMENT.test(segment);
    return patternSegment === segment;
  });
}

/**
 * True when this inbound URL may be routed. Callers that get `false` should
 * ignore the link entirely rather than trying to sanitize it.
 */
export function isAllowedDeepLink(url: string, policy: DeepLinkPolicy): boolean {
  const path = parseDeepLinkPath(url, policy.scheme);
  if (path === null) return false;

  return policy.allowedPaths.some((pattern) => matchesPattern(path, pattern));
}

/**
 * Routes the rider app accepts from outside. Auth screens are included
 * because the OTP flow can legitimately be resumed from a link; everything
 * else (ride creation, account) must be reached from inside the app.
 */
export const RIDER_DEEP_LINK_POLICY: DeepLinkPolicy = {
  scheme: "campusride-rider",
  allowedPaths: ["", "auth/phone", "auth/otp", "auth/signup", "rides"],
};

/** Routes the driver app accepts from outside, including one ride detail screen. */
export const DRIVER_DEEP_LINK_POLICY: DeepLinkPolicy = {
  scheme: "campusride-driver",
  allowedPaths: ["", "auth/phone", "auth/otp", "auth/signup", "rides", "ride/:id"],
};
