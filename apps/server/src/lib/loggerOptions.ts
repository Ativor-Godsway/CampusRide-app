import type { FastifyServerOptions } from "fastify";
import { redactError, redactText, redactValue } from "./redact";

/**
 * Fastify's (pino) logger, with every line scrubbed (lib/redact.ts): no full
 * phone numbers, tokens or secrets reach Render's logs, whether they come in
 * a log object, a message, a request URL or an error.
 */
export const loggerOptions: FastifyServerOptions["logger"] = {
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    // Fastify's own request line, with the URL scrubbed (/track/<token>,
    // ?phone=…). Headers and bodies are never logged.
    req(request: {
      method?: string;
      url?: string;
      ip?: string;
      host?: string;
      socket?: { remotePort?: number };
    }) {
      return {
        method: request.method,
        url: request.url ? redactText(request.url) : request.url,
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
    err(err: Error) {
      return redactError(err) as { type: string; message: string; stack: string };
    },
  },
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map((arg) => redactValue(arg)) as Parameters<typeof method>);
    },
  },
};
