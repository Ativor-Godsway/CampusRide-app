import { limiter, type LimitCheck } from "./limiter";
import { PERSON_RULES } from "./rules";

/** One limit as the admin site shows it. */
export interface PersonLimitStatus {
  name: string;
  label: string;
  /** What it counts against: the number itself, or its account. */
  scope: "phone" | "account";
  used: number;
  max: number;
  windowSeconds: number;
  /** Seconds until it resets; 0 when nothing is counted. */
  resetsInSeconds: number;
  blocked: boolean;
}

/** Every per-number limit, plus every per-account limit when the number has an account. */
function checksFor(phone: string, userId: string | null): LimitCheck[] {
  return PERSON_RULES.flatMap((rule): LimitCheck[] => {
    if (rule.subject === "phone") return [{ rule, subject: phone }];
    return userId ? [{ rule, subject: userId }] : [];
  });
}

/**
 * The limits a person is currently using (anything with a count), blocked
 * ones first — what support needs for "I can't log in".
 */
export async function personLimitStatus(
  phone: string,
  userId: string | null,
  now: number = Date.now(),
): Promise<PersonLimitStatus[]> {
  const statuses = await Promise.all(
    checksFor(phone, userId).map((check) => limiter.status(check, now)),
  );
  return statuses
    .filter((s) => s.used > 0)
    .map((s) => ({
      name: s.rule.name,
      label: s.rule.label,
      scope: s.rule.subject === "phone" ? ("phone" as const) : ("account" as const),
      used: s.used,
      max: s.max,
      windowSeconds: Math.round(s.rule.windowMs / 1000),
      resetsInSeconds: Math.ceil(s.resetsInMs / 1000),
      blocked: s.blocked,
    }))
    .sort((a, b) => Number(b.blocked) - Number(a.blocked) || a.name.localeCompare(b.name));
}

/** Clears every per-number and per-account limit of a person; returns what was in use. */
export async function clearPersonLimits(
  phone: string,
  userId: string | null,
  now: number = Date.now(),
): Promise<PersonLimitStatus[]> {
  const before = await personLimitStatus(phone, userId, now);
  await Promise.all(checksFor(phone, userId).map((check) => limiter.clear(check)));
  return before;
}
