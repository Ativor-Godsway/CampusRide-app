/**
 * Building blocks for the JSON schemas every route declares (Stage 4).
 *
 * Every object schema has `additionalProperties: false`. Fastify's validator
 * then DROPS any field a route doesn't list before the handler runs: an
 * unexpected `role` or `isApproved` never reaches the code, and an older app
 * that sends an extra field keeps working. Strings have maximum lengths; ids,
 * coordinates and enums are checked. Phone numbers are length-checked here
 * and parsed by the shared parser in the handler (no regex can express every
 * spelling it accepts, invisible characters included).
 *
 * Validation runs after requireAuth (onRequest), so someone not signed in
 * learns nothing from it. A failure is a 400 with the problem in plain
 * words (http/errors.ts).
 */

import type { preValidationAsyncHookHandler } from "fastify";

type Schema = Record<string, unknown>;

/**
 * For a route whose body is optional (accept a ride, "I'm here", delete my
 * account): a request with no body at all validates as `{}`. Declared on the
 * route itself, so the route behaves the same in any app it is registered in.
 */
export const bodyOptional: preValidationAsyncHookHandler = async (request) => {
  if (request.body === undefined || request.body === null) request.body = {};
};

/** How long free-text fields may be. */
export const MAX = {
  name: 60,
  vehicleField: 40,
  plate: 20,
  phone: 40,
  /** Rider cancel note and pickup note are trimmed and checked by their own parsers, which give friendlier messages. */
  freeText: 1000,
  comment: 500,
  reason: 500,
  url: 500,
  token: 2048,
  pushToken: 255,
  otpCode: 10,
  query: 200,
} as const;

/** An object with exactly these properties (anything else is dropped). */
export function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

/** No fields at all: anything sent is dropped. */
export const empty = object({});

/** A Prisma id as it appears in a URL or body (cuid), or the short test ids. */
export const id: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9_-]+$",
};
export const nullableId: Schema = { ...id, type: ["string", "null"] };

/** Length-checked here, parsed by the shared Ghana number parser in the handler. */
export const phone: Schema = { type: "string", minLength: 1, maxLength: MAX.phone };

export function text(
  maxLength: number,
  opts: { nonEmpty?: boolean; nullable?: boolean } = {},
): Schema {
  return {
    type: opts.nullable ? ["string", "null"] : "string",
    ...(opts.nonEmpty ? { minLength: 1 } : {}),
    maxLength,
  };
}

export function oneOf(values: readonly string[], opts: { nullable?: boolean } = {}): Schema {
  return {
    type: opts.nullable ? ["string", "null"] : "string",
    enum: opts.nullable ? [...values, null] : [...values],
  };
}

export function integer(minimum: number, maximum: number): Schema {
  return { type: "integer", minimum, maximum };
}

export const latitude: Schema = { type: "number", minimum: -90, maximum: 90 };
export const longitude: Schema = { type: "number", minimum: -180, maximum: 180 };
export const boolean: Schema = { type: "boolean" };

/** `:id` in the URL. */
export const idParams = object({ id }, ["id"]);

/** Route options for a route that takes nothing: no query, no body. */
export const noInput = { querystring: empty };
