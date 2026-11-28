/**
 * Investor view: the admin site shown to investors on a screen share. While
 * it is on, every answer from the API's /admin routes is masked here, before
 * any page sees it, so no page can forget to: people's names become
 * "Rider #4821", "Driver D317" or "Admin", phone numbers "054 *** **46",
 * number plates "GT •••• ••", and a known name inside a sentence (a ride's
 * timeline, an audit note) is replaced too. Places, zones and numbers are
 * left alone. The same id always gets the same label, so a table still
 * reads consistently.
 *
 * On/off is kept for the admin session only (auth.tsx's session end time is
 * the key): signing in again starts with it off.
 */

let on = false;

export function setInvestorMasking(value: boolean): void {
  on = value;
}

export function investorMaskingOn(): boolean {
  return on;
}

type Kind = "rider" | "driver" | "admin" | "person";

/** A stable small number for an id (FNV-1a). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** "Rider #4821", "Driver D317", "Admin", "Person #1093". */
export function personLabel(kind: Kind, id: string): string {
  const n = hash(id);
  if (kind === "rider") return `Rider #${1000 + (n % 9000)}`;
  if (kind === "driver") return `Driver D${100 + (n % 900)}`;
  if (kind === "admin") return "Admin";
  return `Person #${1000 + (n % 9000)}`;
}

/** "054 *** **46" from "+233541234546"; "0** *** **46" from a masked "+233*****146"; null for no number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d*]/g, "");
  const local = digits.startsWith("233") ? digits.slice(3) : digits.startsWith("0") ? digits.slice(1) : digits;
  const last2 = local.replace(/\*/g, "").slice(-2).padStart(2, "*");
  const firstTwo = /^\d\d/.test(local) ? local.slice(0, 2) : "**";
  return `0${firstTwo} *** **${last2}`;
}

/** "GT •••• ••" from "GT 4821-22". */
export function maskPlate(plate: string): string {
  const letters = plate.trim().match(/^[A-Za-z]{1,3}/)?.[0] ?? "";
  return `${letters.toUpperCase()} •••• ••`.trim();
}

const PHONE_IN_TEXT = /(\+?233|0)\s?\d{2}\s?\d{3}\s?\d{4}\b|\+233\*{3,}\d{2,4}/g;

/** Keys whose object value is a person of a known kind. */
const PERSON_KEYS: Record<string, Kind> = {
  rider: "rider",
  riders: "rider",
  passenger: "rider",
  passengers: "rider",
  rater: "person",
  ratee: "driver",
  driver: "driver",
  drivers: "driver",
  admin: "admin",
  admins: "admin",
  actor: "admin",
  updatedBy: "admin",
  user: "person",
  me: "admin",
};

/** Keys holding a person's name as a string, and whose. */
const NAME_KEYS: Record<string, Kind> = {
  riderName: "rider",
  driverName: "driver",
  adminName: "admin",
  actorName: "admin",
  recordedBy: "admin",
  by: "admin",
  handledBy: "admin",
};

/** Not people: who recorded a Paystack payment, the server. */
const KEEP = new Set(["Paystack", "Unknown admin", "Unknown driver", "Unknown"]);

/** The id beside a name ("riderId" for "riderName"), else the name itself. */
function siblingId(obj: Record<string, unknown>, key: string): string {
  const base = key.replace(/Name$/, "");
  for (const k of [`${base}Id`, `${base}UserId`, "userId", "id"]) {
    if (typeof obj[k] === "string") return obj[k] as string;
  }
  return String(obj[key]);
}

/** What kind of person an object with a `name` is, or null if it isn't one (a place, a zone). */
function personKind(obj: Record<string, unknown>, parentKey: string | null): Kind | null {
  if (typeof obj.name !== "string") return null;
  if (parentKey && parentKey in PERSON_KEYS) return PERSON_KEYS[parentKey]!;
  if (obj.role === "RIDER") return "rider";
  if (obj.role === "DRIVER") return "driver";
  if (obj.role === "ADMIN") return "admin";
  if ("plate" in obj || "driverId" in obj || "isApproved" in obj) return "driver";
  if ("maskedPhone" in obj || "phone" in obj || "joinedAt" in obj) return "rider";
  return null;
}

/** Search results: { kind: "rider" | "driver", title: name, subtitle }. */
function isSearchResult(obj: Record<string, unknown>): boolean {
  return (obj.kind === "rider" || obj.kind === "driver") && typeof obj.title === "string" && typeof obj.id === "string";
}

function collect(value: unknown, parentKey: string | null, names: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collect(v, parentKey, names);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const kind = personKind(obj, parentKey);
  if (kind && !names.has(obj.name as string)) {
    const id = String(obj.userId ?? obj.id ?? obj.driverId ?? obj.name);
    names.set(obj.name as string, personLabel(kind, id));
  }
  if (isSearchResult(obj) && !names.has(obj.title as string)) names.set(obj.title as string, personLabel(obj.kind as Kind, obj.id as string));
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && k in NAME_KEYS) {
      if (!names.has(v) && !KEEP.has(v)) names.set(v, personLabel(NAME_KEYS[k]!, siblingId(obj, k)));
    } else collect(v, k, names);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces known names (whole words, longest first) and phone numbers inside free text. */
function scrubText(text: string, pattern: RegExp | null, names: Map<string, string>): string {
  let out = text.replace(PHONE_IN_TEXT, (m) => maskPhone(m));
  if (pattern) out = out.replace(pattern, (m) => names.get(m) ?? m);
  return out;
}

function apply(value: unknown, parentKey: string | null, names: Map<string, string>, pattern: RegExp | null): unknown {
  if (Array.isArray(value)) return value.map((v) => apply(v, parentKey, names, pattern));
  if (typeof value === "string") return scrubText(value, pattern, names);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const kind = personKind(obj, parentKey);
  const search = isSearchResult(obj);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      if (k === "name" && kind) out[k] = names.get(v) ?? personLabel(kind, String(obj.userId ?? obj.id ?? v));
      else if (k in NAME_KEYS) out[k] = KEEP.has(v) ? v : (names.get(v) ?? personLabel(NAME_KEYS[k]!, siblingId(obj, k)));
      else if (/phone/i.test(k)) out[k] = maskPhone(v);
      else if (k === "plate") out[k] = maskPlate(v);
      else if (k === "photoUrl") out[k] = null;
      else if (search && k === "title") out[k] = names.get(v) ?? v;
      else out[k] = scrubText(v, pattern, names);
    } else {
      out[k] = apply(v, k, names, pattern);
    }
  }
  return out;
}

/**
 * The answer with every person's name, phone number, plate and photo
 * masked. Names are collected first, then replaced wherever they appear.
 */
export function maskPayload<T>(body: T): T {
  const names = new Map<string, string>();
  collect(body, null, names);
  const known = [...names.keys()].filter((n) => n.trim().length >= 3).sort((a, b) => b.length - a.length);
  const pattern = known.length ? new RegExp(`(?<![\\p{L}])(${known.map(escapeRegExp).join("|")})(?![\\p{L}])`, "gu") : null;
  return apply(body, null, names, pattern) as T;
}

const STORE_KEY = "campusride.admin.investorView";

/** Whether investor view is on for this admin session (`sessionKey`: when the session ends). */
export function readInvestorView(sessionKey: string): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === sessionKey;
  } catch {
    return false;
  }
}

export function writeInvestorView(sessionKey: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(STORE_KEY, sessionKey);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Blocked storage: on for this tab only.
  }
}
