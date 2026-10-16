import type { FastifyError, FastifyInstance, FastifySchemaValidationError } from "fastify";
import { noteDatabaseError } from "../lib/alerts";
import { reportError } from "../lib/monitoring";

/**
 * One shape for every error the API sends, and nothing internal in it
 * (Stage 4):
 *
 *   { "error": "<a sentence a person can read>", "code": "<STABLE_CODE>", "requestId": "<id>" }
 *
 * - A request that fails its route's JSON schema: 400 INVALID_REQUEST, with
 *   the first problem in plain words ("name must be at most 60 characters").
 * - Fastify's own refusals (bad JSON, wrong content type, body too large):
 *   their status, a short safe message.
 * - Anything else — a Prisma error, a bug, a timeout — is logged in full
 *   (scrubbed, lib/redact.ts) with the request id, and the client gets only
 *   500 INTERNAL_ERROR and that id. No stack trace, Prisma message or SQL ever
 *   leaves the server, in any environment.
 *
 * Every response carries an `X-Request-Id` header, so a report from a user
 * ("it said request 3f2c…") finds the exact log line.
 */

const GENERIC_BY_STATUS: Record<number, string> = {
  400: "That request isn't valid.",
  401: "Please sign in again.",
  403: "You can't do that.",
  404: "Not found.",
  405: "That method isn't allowed here.",
  408: "The request took too long.",
  409: "That conflicts with something that changed. Refresh and try again.",
  413: "That request is too large.",
  415: "That kind of request body isn't accepted.",
};

const INTERNAL_MESSAGE = "Something went wrong on our side. Please try again.";

/** The field a schema error is about, e.g. "pickup.latitude". */
function fieldOf(error: FastifySchemaValidationError, context: string | undefined): string {
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  if (error.keyword === "required") {
    const missing = String((error.params as { missingProperty?: unknown }).missingProperty ?? "");
    return path ? `${path}.${missing}` : missing;
  }
  if (path) return path;
  return context === "querystring" ? "query" : (context ?? "request");
}

/** The first schema problem, as a sentence. */
export function describeValidationError(
  errors: FastifySchemaValidationError[],
  context?: string,
): string {
  const error = errors[0];
  if (!error) return GENERIC_BY_STATUS[400]!;
  const field = fieldOf(error, context);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return `${field} is required`;
    case "type": {
      const type = String(params.type).replace(/,/g, " or ");
      return field === "body"
        ? "The request body must be a JSON object"
        : `${field} must be ${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
    }
    case "enum":
      return `${field} must be one of: ${(params.allowedValues as unknown[]).join(", ")}`;
    case "maxLength":
      return `${field} must be at most ${params.limit} characters`;
    case "minLength":
      return params.limit === 1
        ? `${field} can't be empty`
        : `${field} must be at least ${params.limit} characters`;
    case "maximum":
      return `${field} must be at most ${params.limit}`;
    case "minimum":
      return `${field} must be at least ${params.limit}`;
    case "maxItems":
      return `${field} can have at most ${params.limit} items`;
    case "minItems":
      return `${field} needs at least ${params.limit} items`;
    case "pattern":
    case "format":
      return `${field} isn't in a valid format`;
    default:
      return `${field} ${error.message ?? "is invalid"}`;
  }
}

/** A stable machine-readable code for a Fastify refusal. */
function codeFor(status: number, error: FastifyError): string {
  if (status === 413) return "BODY_TOO_LARGE";
  if (status === 415) return "UNSUPPORTED_MEDIA_TYPE";
  if (
    error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    error.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
  )
    return "INVALID_JSON";
  return status === 404 ? "NOT_FOUND" : "BAD_REQUEST";
}

export function installErrorHandling(app: FastifyInstance): void {
  // A POST/PATCH/PUT with no body at all is treated as `{}`, so a route whose
  // body is optional (accept a ride, "I'm here") validates, and a route with
  // required fields says which one is missing rather than "body must be object".
  app.addHook("preValidation", async (request) => {
    if (request.body === undefined && request.routeOptions.schema?.body) request.body = {};
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (error.validation) {
      return reply.code(400).send({
        error: describeValidationError(error.validation, error.validationContext),
        code: "INVALID_REQUEST",
        requestId,
      });
    }

    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      // Fastify's own refusals have short, safe messages; anything else gets
      // the plain sentence for its status.
      const safe = typeof error.code === "string" && error.code.startsWith("FST_");
      request.log.info({ err: error }, "Request refused");
      return reply.code(status).send({
        error:
          status === 413
            ? GENERIC_BY_STATUS[413]
            : safe
              ? error.message
              : (GENERIC_BY_STATUS[status] ?? GENERIC_BY_STATUS[400]),
        code: codeFor(status, error),
        requestId,
      });
    }

    request.log.error({ err: error, requestId }, "Unhandled error");
    // To Sentry (Stage 5) with the same request id the user was shown.
    reportError(error, {
      tags: { requestId, route: request.routeOptions.url ?? "unknown", method: request.method },
    });
    noteDatabaseError(error, "request");
    return reply.code(500).send({ error: INTERNAL_MESSAGE, code: "INTERNAL_ERROR", requestId });
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send({ error: GENERIC_BY_STATUS[404], code: "NOT_FOUND", requestId: request.id });
  });
}
