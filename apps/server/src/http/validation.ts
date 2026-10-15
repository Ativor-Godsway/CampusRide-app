import type { FastifyInstance, FastifySchemaCompiler } from "fastify";
import { AjvCompiler } from "@fastify/ajv-compiler";

/**
 * How route schemas are checked (http/schemas.ts):
 *
 * - BODIES are checked strictly: a field must already be the right JSON type.
 *   Fastify's default would quietly turn "5" into 5 or 42 into "42", which
 *   would make the schema LOOSER than the checks the handlers made before.
 * - Query strings and URL params are always text, so they are converted
 *   ("?limit=20" -> 20), as Fastify does by default.
 *
 * Both drop unknown fields (`removeAdditional`) and stop at the first error
 * (allErrors on is a known denial-of-service risk). Every route-registering
 * function calls this first, so routes behave the same in the server and in
 * any test app they are registered on.
 */
const buildCompiler = AjvCompiler();
const strictBodies = buildCompiler({}, { customOptions: { coerceTypes: false, strict: false } });
const convertedText = buildCompiler({}, { customOptions: { strict: false } });

const compiler: FastifySchemaCompiler<unknown> = (route) =>
  (route.httpPart === "body" ? strictBodies : convertedText)(route as never);

export function useRequestValidation(app: FastifyInstance): void {
  app.setValidatorCompiler(compiler);
}
