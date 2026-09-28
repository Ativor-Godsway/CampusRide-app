/**
 * Reading and checking the Cloudinary credentials the server signs uploads with.
 *
 * Three values are needed, read under exactly these names:
 *
 *   CLOUDINARY_CLOUD_NAME   public — it appears in every image URL
 *   CLOUDINARY_API_KEY      public-ish identifier, sent with each upload
 *   CLOUDINARY_API_SECRET   the signing key — server-only, never logged
 *
 * CLOUDINARY_URL (`cloudinary://<key>:<secret>@<cloud>`) is also accepted,
 * because it is the single value Cloudinary's own dashboard puts front and
 * centre; any of the three separate vars that IS set wins over it.
 *
 * Values are trimmed. A trailing space or newline pasted into a dashboard is
 * invisible there but changes the secret, and Cloudinary then answers every
 * upload with "Invalid Signature" — one of the hardest failures to spot.
 */

export interface CloudinarySettings {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

type Env = Record<string, string | undefined>;

/** Parses `cloudinary://<key>:<secret>@<cloud>`; anything malformed yields nothing. */
function parseCloudinaryUrl(raw: string | undefined): Partial<CloudinarySettings> {
  const value = raw?.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    if (url.protocol !== "cloudinary:") return {};
    return {
      cloudName: url.hostname,
      apiKey: decodeURIComponent(url.username),
      apiSecret: decodeURIComponent(url.password),
    };
  } catch {
    return {};
  }
}

export function resolveCloudinaryConfig(env: Env): CloudinarySettings {
  const fromUrl = parseCloudinaryUrl(env.CLOUDINARY_URL);
  const pick = (name: string, fallback: string | undefined) => env[name]?.trim() || fallback || "";

  return {
    cloudName: pick("CLOUDINARY_CLOUD_NAME", fromUrl.cloudName),
    apiKey: pick("CLOUDINARY_API_KEY", fromUrl.apiKey),
    apiSecret: pick("CLOUDINARY_API_SECRET", fromUrl.apiSecret),
  };
}

/** Env var names still needed, in a form an operator can paste into Render. */
export function missingCloudinaryVars(cfg: CloudinarySettings): string[] {
  const missing: string[] = [];
  if (!cfg.cloudName) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!cfg.apiKey) missing.push("CLOUDINARY_API_KEY");
  if (!cfg.apiSecret) missing.push("CLOUDINARY_API_SECRET");
  return missing;
}

interface StartupLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One boot-time line saying whether driver photo uploads can work, so a
 * misconfiguration shows up in the deploy log instead of as a vague failure
 * on a driver's phone.
 *
 * Calls Cloudinary's Admin API `ping` with the same key and secret the
 * signatures use: a wrong secret, a key from another account or a typo in the
 * cloud name all fail here. Never throws, and never logs the key or secret.
 */
export async function checkCloudinaryAtStartup(
  cfg: CloudinarySettings,
  log: StartupLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const missing = missingCloudinaryVars(cfg);
  if (missing.length > 0) {
    log.warn(
      { event: "cloudinary_startup_check", ok: false, missing },
      `Cloudinary is NOT configured: driver photo uploads will fail. Missing env vars: ${missing.join(", ")}`,
    );
    return;
  }

  const auth = Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString("base64");
  try {
    const res = await fetchImpl(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/ping`,
      { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) {
      log.info(
        { event: "cloudinary_startup_check", ok: true, cloudName: cfg.cloudName },
        `Cloudinary credentials verified for cloud "${cfg.cloudName}"`,
      );
      return;
    }
    const cloudinaryMessage = await readCloudinaryError(res);
    log.error(
      {
        event: "cloudinary_startup_check",
        ok: false,
        status: res.status,
        cloudName: cfg.cloudName,
        cloudinaryMessage,
      },
      `Cloudinary REJECTED the configured credentials (HTTP ${res.status}): driver photo uploads will fail. ` +
        "Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET all come from the same Cloudinary account.",
    );
  } catch (err) {
    log.warn(
      {
        event: "cloudinary_startup_check",
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      },
      "Could not reach Cloudinary to verify the credentials; uploads may still work",
    );
  }
}

async function readCloudinaryError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : null;
  } catch {
    return null;
  }
}
