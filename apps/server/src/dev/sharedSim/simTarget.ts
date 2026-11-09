/**
 * Where `npm run simulate:shared` may run: a LOCAL Postgres only, never
 * production. Stricter than the other dev tools (devDbGuard allows the dev
 * Neon branch too): the simulation creates drivers and riders and books
 * rides, so it runs on this machine's database or not at all.
 */
import { dbHostFromUrl } from "../../db/dbHostGuard";

/** The production database endpoint and API host, refused by name whatever else is set. */
export const PRODUCTION_DB_ENDPOINT = "ep-empty-violet-bay5yr3y";
export const PRODUCTION_API_HOST = "api.campusride.app";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** The variables that could point the simulation (or an app it stands in for) at a server. */
const API_URL_VARIABLES = ["PUBLIC_BASE_URL", "API_URL", "EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_SERVER_URL", "SIM_API_URL"];

/** Throws, in words, unless every database URL is local and no API URL is production. */
export function assertSimTargetIsLocal(env: Record<string, string | undefined>): void {
  if ((env.NODE_ENV ?? "development") === "production") {
    throw new Error("REFUSING TO RUN: NODE_ENV is production. The shared-ride simulation is for a local database only.");
  }
  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    const url = env[name];
    if (!url) {
      if (name === "DATABASE_URL") throw new Error("REFUSING TO RUN: DATABASE_URL is not set (apps/server/.env.development.local).");
      continue;
    }
    if (url.includes(PRODUCTION_DB_ENDPOINT)) {
      throw new Error(`REFUSING TO RUN: ${name} is the PRODUCTION database (${PRODUCTION_DB_ENDPOINT}).`);
    }
    const host = dbHostFromUrl(url);
    if (!host || !LOCAL_HOSTS.includes(host)) {
      throw new Error(
        `REFUSING TO RUN: ${name} points at "${host ?? "an unreadable URL"}", not a local Postgres. ` +
          "Put a localhost DATABASE_URL in apps/server/.env.development.local.",
      );
    }
  }
  for (const name of API_URL_VARIABLES) {
    if (env[name]?.toLowerCase().includes(PRODUCTION_API_HOST)) {
      throw new Error(`REFUSING TO RUN: ${name} is the production API (${PRODUCTION_API_HOST}).`);
    }
  }
}
