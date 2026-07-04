/**
 * Cloudinary image upload — UNSIGNED preset, client-direct from Expo.
 *
 * Both values are PUBLIC and inlined by Expo at build time via `EXPO_PUBLIC_*`
 * (same pattern as the Mapbox token) — there is NO Cloudinary secret in the
 * app bundle. The app uploads the file straight to Cloudinary, gets back a
 * `secure_url`, and persists only that URL via PATCH /driver/profile.
 *
 * TODO(post-buildathon): move to a signed, server-side upload (server holds
 * the API secret / signs params) — see ROADMAP "Deferred". Until then the
 * unsigned preset is the agreed buildathon approach.
 */

const CLOUD_NAME = process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME || undefined;
const UPLOAD_PRESET = process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET || undefined;

/** True only when both public Cloudinary values are configured. */
export function isCloudinaryConfigured(): boolean {
  return Boolean(CLOUD_NAME && UPLOAD_PRESET);
}

/**
 * Uploads a local image URI to Cloudinary via the unsigned preset and returns
 * the resulting `secure_url`. Throws if Cloudinary is unconfigured or the
 * upload fails.
 */
export async function uploadImageToCloudinary(localUri: string): Promise<string> {
  if (!CLOUD_NAME || !UPLOAD_PRESET) {
    throw new Error(
      "Cloudinary is not configured (EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME / EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET).",
    );
  }

  const formData = new FormData();
  // React Native FormData accepts a { uri, name, type } file part; the DOM
  // FormData types don't model it, so cast through unknown to a Blob.
  formData.append("file", {
    uri: localUri,
    name: "profile.jpg",
    type: "image/jpeg",
  } as unknown as Blob);
  formData.append("upload_preset", UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Cloudinary upload failed (${res.status})`);
  }

  const data = (await res.json()) as { secure_url?: string };
  if (!data.secure_url) {
    throw new Error("Cloudinary upload returned no secure_url");
  }
  return data.secure_url;
}
