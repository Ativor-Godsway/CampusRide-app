/**
 * The scrubber every log line passes through. It lives in @rida/shared
 * (packages/shared/src/redact) because the Sentry clients in the apps and
 * the admin site use the same rules; this module keeps the server's imports
 * short.
 */
export { maskPhone, redactError, redactText, redactValue } from "@rida/shared";
