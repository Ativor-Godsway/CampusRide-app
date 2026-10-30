/**
 * Notifications an admin writes and sends from the admin site (and the
 * one-time launch push). Shared by the server (which checks and sends them)
 * and the admin site (which counts characters as they are typed), so the two
 * can never disagree on a limit.
 */

/** Longer titles are cut off on most lock screens. */
export const BROADCAST_TITLE_MAX = 50;
export const BROADCAST_BODY_MAX = 150;

/** Who an admin can send to. PHONE: the one account on a phone number. */
export const BROADCAST_AUDIENCES = ["RIDERS", "DRIVERS", "EVERYONE", "PHONE"] as const;
export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

/** How a send is recorded in the history: the four above, an admin's test, or the launch push. */
export type BroadcastKind = BroadcastAudience | "TEST" | "LAUNCH";

export const BROADCAST_AUDIENCE_LABELS: Record<BroadcastKind, string> = {
  RIDERS: "All riders",
  DRIVERS: "All drivers",
  EVERYONE: "Everyone",
  PHONE: "One phone number",
  TEST: "Test to me",
  LAUNCH: "Launch push (riders)",
};

/** The `data.kind` of an admin notification: the apps open, nothing more (no ride to show). */
export const ANNOUNCEMENT_PUSH_KIND = "ANNOUNCEMENT";

/** Whether a notification's `data` is an admin notification (shown as a banner while the app is open). */
export function isAnnouncementPushData(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).kind === ANNOUNCEMENT_PUSH_KIND
  );
}

/** What riders get when launch mode turns Live, if the switch in Settings is on. */
export const LAUNCH_PUSH_TEXT = {
  title: "CampusRide is live!",
  body: "Book your first ride on campus now.",
} as const;

export interface BroadcastText {
  title: string;
  body: string;
}

/**
 * The title and body as they will be sent (trimmed), or a plain-English
 * reason they can't be. Line breaks are allowed in the body only; other
 * control characters nowhere.
 */
export function checkBroadcastText(
  input: { title?: unknown; body?: unknown },
): { ok: true; text: BroadcastText } | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim().replace(/\r\n?/g, "\n") : "";
  if (!title) return { ok: false, error: "Write a title." };
  if (!body) return { ok: false, error: "Write a message." };
  if (title.length > BROADCAST_TITLE_MAX)
    return { ok: false, error: `The title can be at most ${BROADCAST_TITLE_MAX} characters.` };
  if (body.length > BROADCAST_BODY_MAX)
    return { ok: false, error: `The message can be at most ${BROADCAST_BODY_MAX} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(title))
    return { ok: false, error: "The title must be one line." };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(body))
    return { ok: false, error: "The message has a character that can't be sent." };
  return { ok: true, text: { title, body } };
}
