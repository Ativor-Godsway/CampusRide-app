/**
 * Stage 4: every route says exactly what it accepts. Collected from the real
 * route table, so a new route without a schema — or with a loose one — fails
 * here rather than in production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { prisma } from "../db/prisma";
import { registerAllRoutes } from "../routes";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { CapturingOtpService } from "../services/auth/testFixtures";

type Schema = Record<string, unknown>;

let app: FastifyInstance;
const routes: RouteOptions[] = [];

beforeAll(async () => {
  app = Fastify();
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.includes("HEAD")) routes.push(route);
  });
  registerAllRoutes(app, prisma, {
    otpService: new CapturingOtpService(),
    paymentService: new DummyPaymentService(),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const name = (route: RouteOptions) => `${String(route.method)} ${route.url}`;

/** Every place a schema is looser than the rules allow, as "path: problem". */
function loosenesses(schema: Schema, path: string): string[] {
  const types = ([] as unknown[]).concat(schema.type ?? []);
  const problems: string[] = [];
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) problems.push(`${path}: allows unlisted fields`);
    for (const [key, child] of Object.entries(
      (schema.properties ?? {}) as Record<string, Schema>,
    )) {
      problems.push(...loosenesses(child, `${path}.${key}`));
    }
  }
  if (types.includes("string") && schema.maxLength === undefined && schema.enum === undefined) {
    problems.push(`${path}: string with no maximum length`);
  }
  if (types.includes("array")) {
    if (schema.maxItems === undefined) problems.push(`${path}: array with no maximum size`);
    if (schema.items) problems.push(...loosenesses(schema.items as Schema, `${path}[]`));
  }
  if (
    (types.includes("number") || types.includes("integer")) &&
    (schema.minimum === undefined || schema.maximum === undefined)
  ) {
    problems.push(`${path}: number with no range`);
  }
  if (types.length === 0) problems.push(`${path}: no type`);
  return problems;
}

describe("every route has a schema", () => {
  it("found the whole route table", () => {
    expect(routes.length).toBeGreaterThan(60);
  });

  it("declares its body, its URL parameters and (for reads) its query", () => {
    const missing: string[] = [];
    for (const route of routes) {
      const schema = (route.schema ?? {}) as Schema;
      const method = String(route.method);
      if (["POST", "PATCH", "PUT"].includes(method) && !schema.body)
        missing.push(`${name(route)}: body`);
      if (["GET", "DELETE"].includes(method) && !schema.querystring)
        missing.push(`${name(route)}: query`);
      const params = [...route.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
      if (params.length > 0) {
        const declared = schema.params as Schema | undefined;
        const required = (declared?.required ?? []) as string[];
        for (const param of params) {
          if (!required.includes(param)) missing.push(`${name(route)}: params.${param}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("allows no unlisted fields, no unbounded strings or arrays, no unbounded numbers", () => {
    const problems: string[] = [];
    for (const route of routes) {
      const schema = (route.schema ?? {}) as Schema;
      for (const part of ["body", "querystring", "params"] as const) {
        if (schema[part])
          problems.push(...loosenesses(schema[part] as Schema, `${name(route)} ${part}`));
      }
    }
    expect(problems).toEqual([]);
  });
});
