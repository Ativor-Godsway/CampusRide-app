/**
 * `npm run staging:seed --workspace apps/server` — puts CampusRide's SETUP
 * data on the staging database (STAGING.md): zones, zone neighbours, the
 * precomputed zone-to-zone routes, places (with their far ends), and the
 * settings rows (launch, service hours, commission, prices, wait fee,
 * dispatch). Nothing personal: no rider, driver, phone, name, push token,
 * ride, payment, log — not even the route cache, whose keys are riders'
 * exact pins. Who last changed a setting (an admin's id) is blanked.
 *
 * It loads from apps/server/.staging/setup-snapshot.json (gitignored). To
 * take a fresh snapshot, pass `--from-env SOURCE_DATABASE_URL`: the named
 * variable holds a database URL to READ the setup tables from — a throwaway
 * Neon branch copied from production, never production's own endpoint
 * (refused) and never staging itself. Only those tables are read.
 *
 * Safe to run again: settings and setup rows are written as in the snapshot;
 * zone routes and neighbours are replaced; rows staging has made itself are
 * left alone.
 */
import "./env"; // MUST stay first: loads .env.staging and refuses anything but the staging branch.
import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { KNOWN_PROD_DB_HOSTS, dbHostFromUrl } from "../../db/dbHostGuard";
import { PRODUCTION_ENDPOINT, STAGING_DB_HOST_PREFIX } from "../../db/stagingGuard";
import { SERVER_ROOT } from "./env";

export const SNAPSHOT_FILE = path.join(SERVER_ROOT, ".staging", "setup-snapshot.json");

/** Model name → its table, as both Prisma and SQL know them. */
const TABLES = {
  zone: "Zone",
  zoneAdjacency: "ZoneAdjacency",
  zoneRoute: "ZoneRoute",
  place: "Place",
  launchSetting: "LaunchSetting",
  serviceHoursSetting: "ServiceHoursSetting",
  commissionSetting: "CommissionSetting",
  farePricingSetting: "FarePricingSetting",
  waitFeeSetting: "WaitFeeSetting",
  dispatchSetting: "DispatchSetting",
} as const;

/**
 * Read with plain SQL (every column the SOURCE has), written with only the
 * columns THIS checkout's schema has: production may be a migration behind
 * or ahead of the branch being tested, and either way the seed works.
 */
async function readTable(source: PrismaClient, model: keyof typeof TABLES): Promise<Row[]> {
  return source.$queryRawUnsafe<Row[]>(`SELECT * FROM "${TABLES[model]}"`);
}

function onlyKnownColumns(model: keyof typeof TABLES, rows: Row[]): Row[] {
  const name = TABLES[model];
  const fields = new Set(
    Prisma.dmmf.datamodel.models.find((m) => m.name === name)!.fields.filter((f) => f.kind !== "object").map((f) => f.name),
  );
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.has(k))));
}

const SETTINGS = [
  "launchSetting",
  "serviceHoursSetting",
  "commissionSetting",
  "farePricingSetting",
  "waitFeeSetting",
  "dispatchSetting",
] as const;

type Row = Record<string, unknown>;
export interface SetupSnapshot {
  takenAt: string;
  zones: Row[];
  zoneAdjacencies: Row[];
  zoneRoutes: Row[];
  places: Row[];
  settings: Record<(typeof SETTINGS)[number], Row[]>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A source to read setup data from: anything but production and staging. */
function assertSourceUrl(url: string | undefined): string {
  if (!url) throw new Error("The source variable is empty.");
  const host = dbHostFromUrl(url);
  if (!host) throw new Error("The source URL isn't a valid database URL.");
  if (url.includes(PRODUCTION_ENDPOINT) || KNOWN_PROD_DB_HOSTS.some((p) => host.includes(p))) {
    throw new Error("REFUSING: the source is the PRODUCTION database. Read from a throwaway copy branch instead (STAGING.md).");
  }
  if (host.startsWith(STAGING_DB_HOST_PREFIX)) throw new Error("The source is the staging database itself.");
  return url;
}

async function takeSnapshot(source: PrismaClient): Promise<SetupSnapshot> {
  const settings = {} as SetupSnapshot["settings"];
  for (const name of SETTINGS) {
    const rows = await readTable(source, name);
    settings[name] = rows.map((r) => ("updatedBy" in r ? { ...r, updatedBy: null } : r));
  }
  return {
    takenAt: new Date().toISOString(),
    zones: await readTable(source, "zone"),
    zoneAdjacencies: await readTable(source, "zoneAdjacency"),
    zoneRoutes: await readTable(source, "zoneRoute"),
    places: await readTable(source, "place"),
    settings,
  };
}

async function load(target: PrismaClient, raw: SetupSnapshot): Promise<void> {
  const snap: SetupSnapshot = {
    ...raw,
    zones: onlyKnownColumns("zone", raw.zones),
    zoneAdjacencies: onlyKnownColumns("zoneAdjacency", raw.zoneAdjacencies),
    zoneRoutes: onlyKnownColumns("zoneRoute", raw.zoneRoutes),
    places: onlyKnownColumns("place", raw.places),
    settings: Object.fromEntries(SETTINGS.map((s) => [s, onlyKnownColumns(s, raw.settings[s])])) as SetupSnapshot["settings"],
  };
  for (const z of snap.zones) await target.zone.upsert({ where: { id: z.id as string }, create: z as never, update: z as never });
  for (const p of snap.places) await target.place.upsert({ where: { id: p.id as string }, create: p as never, update: p as never });
  await target.zoneAdjacency.deleteMany({});
  await target.zoneAdjacency.createMany({ data: snap.zoneAdjacencies as never, skipDuplicates: true });
  await target.zoneRoute.deleteMany({});
  for (let i = 0; i < snap.zoneRoutes.length; i += 500) {
    await target.zoneRoute.createMany({ data: snap.zoneRoutes.slice(i, i + 500) as never, skipDuplicates: true });
  }
  for (const name of SETTINGS) {
    const model = target[name] as unknown as { upsert: (a: object) => Promise<unknown> };
    for (const row of snap.settings[name]) {
      const data = { ...row, updatedBy: null };
      await model.upsert({ where: { id: row.id }, create: data, update: data });
    }
  }
}

async function main(): Promise<void> {
  const target = new PrismaClient({ log: ["error"] });
  try {
    const fromEnv = arg("from-env");
    let snap: SetupSnapshot;
    if (fromEnv) {
      const source = new PrismaClient({ log: ["error"], datasources: { db: { url: assertSourceUrl(process.env[fromEnv]) } } });
      try {
        console.log(`\nReading setup tables from the source (${dbHostFromUrl(process.env[fromEnv]!)})…`);
        snap = await takeSnapshot(source);
      } finally {
        await source.$disconnect();
      }
      fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap), { mode: 0o600 });
      console.log(`Snapshot saved to apps/server/.staging/setup-snapshot.json (gitignored).`);
    } else {
      if (!fs.existsSync(SNAPSHOT_FILE)) throw new Error("No snapshot yet (apps/server/.staging/setup-snapshot.json). See STAGING.md.");
      snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as SetupSnapshot;
    }
    console.log(
      `Loading into staging: ${snap.zones.length} zones, ${snap.zoneAdjacencies.length} neighbour pairs, ${snap.zoneRoutes.length} zone routes, ` +
        `${snap.places.length} places, ${SETTINGS.filter((s) => snap.settings[s].length > 0).length} settings (snapshot of ${snap.takenAt})…`,
    );
    await load(target, snap);
    console.log("Done.\n");
  } finally {
    await target.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
