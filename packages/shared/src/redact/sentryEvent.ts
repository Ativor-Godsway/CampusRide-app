import { redactText, redactValue, type RedactOptions } from "./redact";

/**
 * The `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb` scrubber
 * shared by every Sentry client: the server, the rider and driver apps and
 * the admin site. Applies ./redact.ts to exactly the parts of an event that
 * can carry a person's data, and drops the ones nobody needs:
 *
 * - messages, exception messages, breadcrumbs, extras, tags, contexts and
 *   span data: phone numbers masked, tokens and secret-named fields removed;
 * - the request: URL and query scrubbed, body, cookies and environment
 *   dropped, headers cut down to a short harmless list;
 * - the user: only an id, never an IP address, email or phone.
 *
 * Ids Sentry itself relies on (event, trace and span ids, which are long hex
 * strings) and stack frames are left untouched, or grouping, tracing and
 * source maps would break. Written against the plain event shape, not
 * Sentry's types, so this package needs no Sentry dependency.
 */

type Obj = Record<string, unknown>;

const DEEP: RedactOptions = { maxDepth: 12, passthrough: new Set() };

/** Request headers worth keeping on an error report; every other header is dropped. */
const KEPT_HEADERS = new Set([
  "user-agent",
  "content-type",
  "content-length",
  "x-campusride-client",
  "x-request-id",
]);

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scrubString(value: unknown): unknown {
  return typeof value === "string" ? redactText(value) : value;
}

function scrubRequest(request: Obj): void {
  request.url = scrubString(request.url);
  if (request.query_string !== undefined)
    request.query_string = redactValue(request.query_string, 0, DEEP);
  delete request.data;
  delete request.cookies;
  delete request.env;
  if (isObj(request.headers)) {
    const kept: Obj = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (KEPT_HEADERS.has(name.toLowerCase())) kept[name] = scrubString(value);
    }
    request.headers = kept;
  }
}

/** One breadcrumb, scrubbed in place (also usable as `beforeBreadcrumb`). */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  const crumb = breadcrumb as unknown as Obj;
  if (!isObj(crumb)) return breadcrumb;
  crumb.message = scrubString(crumb.message);
  if (crumb.data !== undefined) crumb.data = redactValue(crumb.data, 0, DEEP);
  return breadcrumb;
}

function scrubSpan(span: Obj): void {
  span.description = scrubString(span.description);
  if (span.data !== undefined) span.data = redactValue(span.data, 0, DEEP);
}

/** An error or transaction event, scrubbed in place and returned. */
export function scrubSentryEvent<T>(event: T): T {
  const e = event as unknown as Obj;
  if (!isObj(e)) return event;

  e.message = scrubString(e.message);
  if (isObj(e.logentry)) {
    e.logentry.message = scrubString(e.logentry.message);
    if (e.logentry.params !== undefined)
      e.logentry.params = redactValue(e.logentry.params, 0, DEEP);
  }
  e.transaction = scrubString(e.transaction);

  const exception = isObj(e.exception) ? e.exception : null;
  if (exception && Array.isArray(exception.values)) {
    for (const value of exception.values) {
      if (!isObj(value)) continue;
      value.value = scrubString(value.value);
      const frames = isObj(value.stacktrace) ? value.stacktrace.frames : null;
      if (Array.isArray(frames)) for (const frame of frames) if (isObj(frame)) delete frame.vars;
    }
  }

  if (Array.isArray(e.breadcrumbs)) e.breadcrumbs.forEach((crumb) => scrubSentryBreadcrumb(crumb));
  if (isObj(e.request)) scrubRequest(e.request);
  if (e.extra !== undefined) e.extra = redactValue(e.extra, 0, DEEP);
  if (e.tags !== undefined) e.tags = redactValue(e.tags, 0, DEEP);

  if (isObj(e.contexts)) {
    for (const [name, context] of Object.entries(e.contexts)) {
      if (!isObj(context)) continue;
      if (name === "trace") scrubSpan(context);
      else e.contexts[name] = redactValue(context, 0, DEEP);
    }
  }

  if (isObj(e.user)) {
    if (typeof e.user.id === "string" || typeof e.user.id === "number") e.user = { id: e.user.id };
    else delete e.user;
  }

  if (Array.isArray(e.spans)) for (const span of e.spans) if (isObj(span)) scrubSpan(span);
  return event;
}
