/**
 * Defensive readers for API list responses.
 *
 * The apps trusted every list inside a response to be an array and called
 * `.length` / `.map` on it directly, so one unexpected body — an old server
 * mid-deploy, an error page from a proxy, a cache entry of a different shape
 * — crashed the whole screen with "Cannot read property 'length' of
 * undefined". The API layer reads responses through these instead, so a
 * screen always receives a real (possibly empty) array.
 */

/** `value` if it is an array, otherwise an empty one. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Reads `body[key]` as an array, tolerating a missing or non-object body. */
export function readList<T>(body: unknown, key: string): T[] {
  if (body === null || typeof body !== "object") return [];
  return asArray<T>((body as Record<string, unknown>)[key]);
}

export interface CursorPage<T> {
  items: T[];
  /** Pass back to fetch the next (older) page; null on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Normalizes a cursor-paginated body such as GET /rides/mine's
 * `{ rides, nextCursor, hasMore }`. `hasMore` is only true when there is also
 * a cursor to continue from, so a caller can never be offered a "load older"
 * that has nothing to load.
 */
export function readCursorPage<T>(body: unknown, key: string): CursorPage<T> {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nextCursor =
    typeof record.nextCursor === "string" && record.nextCursor.length > 0
      ? record.nextCursor
      : null;
  return {
    items: asArray<T>(record[key]),
    nextCursor,
    hasMore: nextCursor !== null,
  };
}
