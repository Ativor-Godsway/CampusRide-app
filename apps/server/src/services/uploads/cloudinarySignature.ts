import { createHash } from "node:crypto";

/**
 * Server-side signing for Cloudinary direct uploads.
 *
 * The app previously uploaded with an UNSIGNED preset whose name shipped in
 * the bundle as EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET. Anyone who unpacked the
 * app (or watched one request) could then upload anything they liked into the
 * account, unauthenticated and unattributed, until the preset was rotated.
 *
 * Now the API secret never leaves the server. The client asks for a
 * short-lived signature over a parameter set WE choose, and Cloudinary
 * rejects any upload whose params don't match that signature — so the
 * destination folder, the public id, the permitted formats and the stored
 * dimensions are all fixed here rather than by the caller.
 */

/** Formats a driver photo may be uploaded as. Signed, so Cloudinary enforces it. */
export const ALLOWED_IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp"] as const;

/** Advisory ceiling on the uploaded file, pre-checked by the client. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Stored images are capped to 1024x1024. `c_limit` only ever scales DOWN, so
 * a smaller photo is left alone rather than being upscaled.
 */
export const UPLOAD_TRANSFORMATION = "c_limit,w_1024,h_1024,q_auto:good";

/** Folder every driver photo lands in. */
export const DRIVER_PHOTO_FOLDER = "campusride/driver-photos";

/**
 * Deterministic public id per driver: one photo per account, and uploading
 * again overwrites that driver's own image. Because the id is part of the
 * signed parameters, a driver cannot overwrite anyone else's photo even if
 * they replay someone else's signature request.
 */
export function driverPhotoPublicId(userId: string): string {
  return `driver_${userId}`;
}

export interface CloudinarySignatureParams {
  [key: string]: string | number | boolean;
}

/**
 * Cloudinary's signature algorithm: take the params to be signed (excluding
 * api_key, file and resource_type), sort by key, join as `k=v` with `&`,
 * append the API secret, and SHA-1 the result.
 */
export function buildSignature(params: CloudinarySignatureParams, apiSecret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return createHash("sha1").update(canonical + apiSecret).digest("hex");
}

export interface DriverPhotoUploadTicket {
  cloudName: string;
  apiKey: string;
  uploadUrl: string;
  /** Exactly the fields the client must POST alongside the file, already signed. */
  params: CloudinarySignatureParams;
  signature: string;
  /** Advisory client-side pre-check so a too-large file fails before the upload. */
  maxBytes: number;
  allowedFormats: readonly string[];
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Builds a signed, single-purpose upload ticket for ONE driver's profile
 * photo. `timestampSeconds` is injectable for deterministic tests; Cloudinary
 * rejects signatures whose timestamp is more than an hour old, which is what
 * bounds how long a leaked ticket stays useful.
 */
export function buildDriverPhotoUploadTicket(
  cfg: CloudinaryConfig,
  userId: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): DriverPhotoUploadTicket {
  const params: CloudinarySignatureParams = {
    allowed_formats: ALLOWED_IMAGE_FORMATS.join(","),
    folder: DRIVER_PHOTO_FOLDER,
    invalidate: true,
    overwrite: true,
    public_id: driverPhotoPublicId(userId),
    timestamp: timestampSeconds,
    transformation: UPLOAD_TRANSFORMATION,
  };

  return {
    cloudName: cfg.cloudName,
    apiKey: cfg.apiKey,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`,
    params,
    signature: buildSignature(params, cfg.apiSecret),
    maxBytes: MAX_UPLOAD_BYTES,
    allowedFormats: ALLOWED_IMAGE_FORMATS,
  };
}

/**
 * Validates a photo URL a driver claims to have just uploaded.
 *
 * The client still reports the resulting URL back via the profile update, so
 * without this check a driver could submit ANY url — pointing our UI at
 * arbitrary third-party content. A genuine upload always lands on this
 * account's Cloudinary host, in our folder, under that driver's own public id.
 */
export function isValidDriverPhotoUrl(url: string, cloudName: string, userId: string): boolean {
  if (!url.startsWith(`https://res.cloudinary.com/${cloudName}/`)) return false;
  return url.includes(`${DRIVER_PHOTO_FOLDER}/${driverPhotoPublicId(userId)}`);
}
