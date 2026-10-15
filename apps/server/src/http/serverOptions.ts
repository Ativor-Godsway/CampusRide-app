import { randomUUID } from "node:crypto";
import type { FastifyServerOptions } from "fastify";
import { loggerOptions } from "../lib/loggerOptions";

/**
 * Largest request body accepted. Every real request is a few hundred bytes
 * (the biggest: an admin place with aliases, a route of 10 points); anything
 * near this is a mistake or an attack and gets 413 BODY_TOO_LARGE.
 */
export const BODY_LIMIT_BYTES = 64 * 1024;

/** Largest single Socket.io message (ride subscriptions and GPS positions are tiny). */
export const SOCKET_MAX_PAYLOAD_BYTES = 16 * 1024;

/** The Fastify options the server runs with (index.ts), minus trustProxy. */
export function serverOptions(): FastifyServerOptions {
  return {
    logger: loggerOptions,
    bodyLimit: BODY_LIMIT_BYTES,
    // A fresh random id per request, never one a client sent: it is what
    // errors show users and what support searches the logs for.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // While shutting down, new requests get 503 so the app retries elsewhere.
    return503OnClosing: true,
  };
}
