/**
 * Rewrites a Cloudinary delivery URL to a right-sized, face-cropped avatar
 * rendition so a small circle never loads the full-res original. Injects the
 * transform segment immediately after `/upload/` (chaining ahead of any
 * existing transforms/version, which stays valid Cloudinary). `size` is the
 * on-screen point size; the rendition is requested at 2× for retina.
 *
 * Non-Cloudinary URLs (or anything without an `/upload/` segment) pass through
 * unchanged. Never throws.
 */
export function cloudinaryAvatar(url: string, size: number): string {
  if (typeof url !== "string" || url.length === 0) return url;
  const marker = "/upload/";
  const index = url.indexOf(marker);
  if (index === -1) return url;

  const px = Math.round(size * 2);
  const transform = `w_${px},h_${px},c_fill,g_face,f_auto,q_auto/`;
  const insertAt = index + marker.length;
  const after = url.slice(insertAt);
  // Idempotent — don't double-apply if this exact segment is already present.
  if (after.startsWith(transform)) return url;
  return url.slice(0, insertAt) + transform + after;
}
