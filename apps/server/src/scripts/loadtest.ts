/**
 * Local load test (Stage 6): how many riders one server handles at once, and
 * what gives out first. Results and how to read them: docs/runbooks/load-test.md.
 *
 *   npm run build:server                       (from the repo root, first)
 *   npm run loadtest --workspace=apps/server -- [--pool=5] [--stage-seconds=60] [--max-riders=2000]
 *                                                [--stages=200,300,500] [--profile]
 *
 * LOCAL ONLY. It starts the built server itself, against the local database
 * `rida_load` (create it first: docs/runbooks/load-test.md), and refuses to
 * run if the database in .env.test isn't on this machine. Riders sign in
 * through the real login routes with the fixed code the server accepts only
 * in this setup (services/auth/loadTestOtp.ts).
 *
 * The scenario, ramped in stages until it degrades:
 * - 50 drivers, each on a trip, send their position every 3 s over Socket.io;
 *   each trip's rider is connected and receives it (the relay delay is
 *   measured), and each driver's app re-reads its trip every 15 s;
 * - riders sign in (code, verify, sign-up), then repeat: request a ride, wait
 *   and look at it, check their active ride, cancel, pause. Each holds a live
 *   connection, as the app does.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import { DRIVER_CLIENT_EVENTS, RIDE_CLIENT_EVENTS, RIDE_EVENTS } from "@rida/shared";

// ─── Settings ───────────────────────────────────────────────────────────────

const SERVER_DIR = path.resolve(__dirname, "../..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=") as [string, string]),
);
const POOL = Number(args.pool ?? 5);
const STAGE_SECONDS = Number(args["stage-seconds"] ?? 60);
const MAX_RIDERS = Number(args["max-riders"] ?? 2000);
const STAGES = (
  args.stages ? args.stages.split(",").map(Number) : [50, 100, 200, 300, 500, 750, 1000, 1500, 2000]
).filter((n) => n <= MAX_RIDERS);
const DRIVERS = 50;
const PORT = Number(args.port ?? 4100);
const BASE = `http://127.0.0.1:${PORT}`;
const OTP_CODE = "246810";
/** --profile: the server writes a CPU profile (open it in Chrome DevTools) to the temp folder. */
const PROFILE = "profile" in args;
/** A stage counts as degraded past either of these. */
const DEGRADED_P95_MS = 1500;
const DEGRADED_ERROR_RATE = 0.02;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

// ─── The local database, and nothing else ───────────────────────────────────

function readEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && `"'`.includes(value[0]!))
      value = value.slice(1, -1);
    env[m[1]!] = value;
  }
  return env;
}

const envTest = readEnvFile(path.join(SERVER_DIR, ".env.test"));
const testUrl = new URL(envTest.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "::1"].includes(testUrl.hostname.replace(/^\[|\]$/g, ""))) {
  console.error("Refusing to run: the database in .env.test is not on this machine.");
  process.exit(1);
}
const loadUrl = new URL(testUrl.toString());
loadUrl.pathname = "/rida_load";
const LOAD_DB_URL = loadUrl.toString();
loadUrl.searchParams.set("connection_limit", String(POOL));
const SERVER_DB_URL = loadUrl.toString();
const JWT_SECRET = envTest.JWT_SECRET ?? "";

// ─── Measurements ───────────────────────────────────────────────────────────

interface Bucket {
  latencies: Map<string, number[]>;
  /** Answers other than 2xx, per request kind and status ("ride: request 409"). */
  refusals: Map<string, number>;
  statuses: Map<number, number>;
  relayDelays: number[];
  relays: number;
  cpu: number[];
  /** The local Postgres's CPU, all its processes together (share of one core). */
  dbCpu: number[];
  rss: number[];
  startedAt: number;
  generatorCpuStart: NodeJS.CpuUsage;
}

function newBucket(): Bucket {
  return {
    latencies: new Map(),
    refusals: new Map(),
    statuses: new Map(),
    relayDelays: [],
    relays: 0,
    cpu: [],
    dbCpu: [],
    rss: [],
    startedAt: performance.now(),
    generatorCpuStart: process.cpuUsage(),
  };
}

let bucket = newBucket();

function record(name: string, ms: number, status: number): void {
  const list = bucket.latencies.get(name) ?? [];
  list.push(ms);
  bucket.latencies.set(name, list);
  bucket.statuses.set(status, (bucket.statuses.get(status) ?? 0) + 1);
  if (status < 200 || status >= 300) {
    const key = `${name} ${status || "no answer"}`;
    bucket.refusals.set(key, (bucket.refusals.get(key) ?? 0) + 1);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function call(
  name: string,
  method: string,
  url: string,
  opts: { token?: string; ip: string; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const started = performance.now();
  try {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        "x-forwarded-for": opts.ip,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    record(name, performance.now() - started, res.status);
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
  } catch {
    record(name, performance.now() - started, 0);
    return { status: 0, json: null };
  }
}

// ─── Simulated people ───────────────────────────────────────────────────────

let running = true;
const sockets: Socket[] = [];
const runId = 100 + Math.floor(Math.random() * 900);
let phoneSerial = 0;
/** A valid, unused Ghana number for this run. */
const nextPhone = () => `+23320${runId}${String(phoneSerial++).padStart(4, "0")}`;
/** A distinct client address per person (RFC 2544 benchmarking range), as each phone has its own. */
const ipFor = (n: number) => `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`;

function accessToken(userId: string, role: "RIDER" | "DRIVER"): string {
  return jwt.sign({ userId, role, typ: "access" }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "2h",
  });
}

function openSocket(token: string): Socket {
  const socket = connect(BASE, {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    forceNew: true,
  });
  sockets.push(socket);
  return socket;
}

interface Trip {
  rideId: string;
  driverId: string;
  riderId: string;
  lat: number;
  lng: number;
}

function startDriver(trip: Trip, n: number): void {
  const token = accessToken(trip.driverId, "DRIVER");
  const socket = openSocket(token);
  const ip = ipFor(5000 + n);
  const move = setInterval(() => {
    if (!running) return clearInterval(move);
    trip.lat += between(-0.0002, 0.0002);
    trip.lng += between(-0.0002, 0.0002);
    if (socket.connected)
      socket.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, {
        rideId: trip.rideId,
        lat: trip.lat,
        lng: trip.lng,
      });
  }, 3000);
  void (async () => {
    await sleep(between(0, 15_000));
    while (running) {
      await call("driver: my trip", "GET", "/driver/rides/active", { token, ip });
      await sleep(15_000);
    }
  })();
}

function startTripRider(trip: Trip): void {
  const socket = openSocket(accessToken(trip.riderId, "RIDER"));
  socket.on("connect", () => socket.emit(RIDE_CLIENT_EVENTS.SUBSCRIBE, trip.rideId));
  socket.on(RIDE_EVENTS.DRIVER_LOCATION, (payload: { ts?: number }) => {
    bucket.relays += 1;
    if (typeof payload.ts === "number") bucket.relayDelays.push(Date.now() - payload.ts);
  });
}

let riderCount = 0;

async function startRider(zones: string[]): Promise<void> {
  const n = riderCount++;
  const ip = ipFor(n);
  const phone = nextPhone();
  const sent = await call("login: request code", "POST", "/auth/request-otp", {
    ip,
    body: { phone, purpose: "SIGNUP" },
  });
  if (sent.status !== 200) return;
  const verified = await call("login: verify code", "POST", "/auth/verify-otp", {
    ip,
    body: { phone, code: OTP_CODE, purpose: "SIGNUP" },
  });
  const verifiedToken = verified.json?.verifiedToken;
  if (typeof verifiedToken !== "string") return;
  const signup = await call("login: sign up", "POST", "/auth/signup", {
    ip,
    body: { phone, name: `Load Rider ${n}`, role: "RIDER", verifiedToken, ageAndTermsConfirmed: true },
  });
  const token = signup.json?.accessToken;
  if (typeof token !== "string") return;
  const socket = openSocket(token);
  await call("app: zones", "GET", "/zones", { token, ip });

  while (running) {
    const [pickupZoneId, dropoffZoneId] = [...zones].sort(() => Math.random() - 0.5);
    const created = await call("ride: request", "POST", "/rides", {
      token,
      ip,
      body: { type: "LONE", pickupZoneId, dropoffZoneId },
    });
    const ride = created.json?.ride as { id?: string } | undefined;
    const rideId = ride?.id ?? (created.json?.activeRideId as string | undefined);
    if (rideId) {
      socket.emit(RIDE_CLIENT_EVENTS.SUBSCRIBE, rideId);
      await sleep(between(4_000, 10_000));
      if (!running) break;
      await call("ride: look", "GET", `/rides/${rideId}`, { token, ip });
      await sleep(between(2_000, 6_000));
      if (!running) break;
      await call("ride: my active ride", "GET", "/rides/active", { token, ip });
      await call("ride: cancel", "POST", `/rides/${rideId}/cancel`, {
        token,
        ip,
        body: { reason: null },
      });
      socket.emit(RIDE_CLIENT_EVENTS.UNSUBSCRIBE, rideId);
    } else {
      await sleep(5_000);
    }
    await sleep(between(5_000, 15_000));
  }
}

// ─── Seeding the drivers' trips ─────────────────────────────────────────────

async function seedTrips(prisma: PrismaClient): Promise<{ trips: Trip[]; zones: string[] }> {
  const zones = await prisma.zone.findMany({
    where: { retiredAt: null },
    select: { id: true, latitude: true, longitude: true },
  });
  if (zones.length < 2)
    throw new Error("rida_load has no zones: seed it first (docs/runbooks/load-test.md)");
  const trips: Trip[] = [];
  for (let i = 0; i < DRIVERS; i++) {
    const pickup = zones[i % zones.length]!;
    const dropoff = zones[(i + 1) % zones.length]!;
    const driver = await prisma.user.create({
      data: { phone: nextPhone(), name: `Load Driver ${i}`, role: "DRIVER" },
    });
    await prisma.driver.create({
      data: {
        userId: driver.id,
        carMake: "Toyota",
        carModel: "Corolla",
        carColor: "Silver",
        plate: `LT-${runId}-${i}`,
        photoUrl: "https://example.com/driver.jpg",
        isApproved: true,
        isOnline: true,
        currentZoneId: pickup.id,
      },
    });
    const rider = await prisma.user.create({
      data: { phone: nextPhone(), name: `Trip Rider ${i}`, role: "RIDER" },
    });
    const ride = await prisma.ride.create({
      data: {
        riderId: rider.id,
        driverId: driver.id,
        type: "LONE",
        status: "MATCHED",
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        occupancy: 1,
        passengers: {
          create: [
            {
              riderId: rider.id,
              pickupZoneId: pickup.id,
              dropoffZoneId: dropoff.id,
              status: "WAITING",
            },
          ],
        },
      },
    });
    trips.push({
      rideId: ride.id,
      driverId: driver.id,
      riderId: rider.id,
      lat: pickup.latitude,
      lng: pickup.longitude,
    });
  }
  return { trips, zones: zones.map((z) => z.id) };
}

// ─── The server under test ──────────────────────────────────────────────────

function startServer(): ChildProcess {
  const logFile = path.join(os.tmpdir(), `campusride-loadtest-server-pool${POOL}.log`);
  // Straight to a file, not through this process: a log pipe that fills up
  // would stall the server and measure this script instead of the server.
  const log = openSync(logFile, "w");
  const profileArgs = PROFILE
    ? ["--cpu-prof", `--cpu-prof-dir=${path.join(os.tmpdir(), "campusride-loadtest-profile")}`]
    : [];
  const server = spawn(process.execPath, [...profileArgs, "dist/apps/server/src/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ...envTest,
      NODE_ENV: "test",
      DATABASE_URL: SERVER_DB_URL,
      DIRECT_URL: LOAD_DB_URL,
      PORT: String(PORT),
      LOAD_TEST_OTP_CODE: OTP_CODE,
      // Requests come from this machine; each simulated phone's own address
      // is in X-Forwarded-For, as Render's proxies pass it on.
      TRUST_PROXY: "loopback",
      LOG_LEVEL: "info",
      SENTRY_DSN: "",
    },
    stdio: ["ignore", log, log],
  });
  console.log(`Server log: ${logFile}`);
  return server;
}

/** The server's CPU (share of one core) and memory, and the local Postgres's CPU, from cumulative CPU time. */
function sampleServer(pid: number): () => void {
  let last: { cpu: number; at: number } | null = null;
  let lastDb: { perPid: Map<string, number>; at: number } | null = null;
  const parseTime = (t: string) =>
    t
      .trim()
      .split(":")
      .reduce((total, part) => total * 60 + Number(part), 0);
  const timer = setInterval(() => {
    try {
      const [time, rss] = execFileSync("ps", ["-o", "time=,rss=", "-p", String(pid)], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
      const cpu = parseTime(time!);
      const at = performance.now();
      if (last) bucket.cpu.push(((cpu - last.cpu) / ((at - last.at) / 1000)) * 100);
      bucket.rss.push(Number(rss) / 1024);
      last = { cpu, at };
      // Per process, and only processes seen in both samples: Postgres starts
      // and ends a process per connection, and a total would jump when one exits.
      const perPid = new Map<string, number>();
      for (const line of execFileSync("ps", ["-A", "-o", "pid=,time=,comm="], {
        encoding: "utf8",
      }).split("\n")) {
        const [pidText, time, comm] = line.trim().split(/\s+/);
        if (comm && /postgres/.test(comm)) perPid.set(pidText!, parseTime(time!));
      }
      if (lastDb) {
        let used = 0;
        for (const [pidText, cpuTime] of perPid) {
          const before = lastDb.perPid.get(pidText);
          if (before !== undefined) used += cpuTime - before;
        }
        bucket.dbCpu.push((used / ((at - lastDb.at) / 1000)) * 100);
      }
      lastDb = { perPid, at };
    } catch {
      // The server has exited.
    }
  }, 2000);
  return () => clearInterval(timer);
}

// ─── Stages ─────────────────────────────────────────────────────────────────

interface StageResult {
  riders: number;
  requests: number;
  perSecond: number;
  errors: number;
  errorRate: number;
  rateLimited: number;
  p50: number;
  p95: number;
  p99: number;
  endpoints: Record<string, { count: number; p50: number; p95: number; max: number }>;
  refusals: Record<string, number>;
  relays: number;
  relayP95: number;
  serverCpuAvg: number;
  serverCpuMax: number;
  serverMemoryMaxMb: number;
  dbCpuAvg: number;
  generatorCpu: number;
  healthP95: number;
  degraded: boolean;
}

function summarize(riders: number): StageResult {
  const seconds = (performance.now() - bucket.startedAt) / 1000;
  const all = [...bucket.latencies.entries()]
    .filter(([name]) => name !== "health")
    .flatMap(([, list]) => list);
  const requests = all.length;
  let errors = 0;
  let rateLimited = 0;
  for (const [status, count] of bucket.statuses) {
    if (status === 0 || status >= 500) errors += count;
    if (status === 429) rateLimited += count;
  }
  const endpoints: StageResult["endpoints"] = {};
  for (const [name, list] of bucket.latencies) {
    endpoints[name] = {
      count: list.length,
      p50: Math.round(percentile(list, 50)),
      p95: Math.round(percentile(list, 95)),
      max: Math.round(Math.max(...list)),
    };
  }
  const generator = process.cpuUsage(bucket.generatorCpuStart);
  const p95 = Math.round(percentile(all, 95));
  const errorRate = requests ? errors / requests : 0;
  return {
    riders,
    requests,
    perSecond: Math.round(requests / seconds),
    errors,
    errorRate: Math.round(errorRate * 10_000) / 100,
    rateLimited,
    p50: Math.round(percentile(all, 50)),
    p95,
    p99: Math.round(percentile(all, 99)),
    endpoints,
    refusals: Object.fromEntries(bucket.refusals),
    relays: bucket.relays,
    relayP95: Math.round(percentile(bucket.relayDelays, 95)),
    serverCpuAvg: Math.round(
      bucket.cpu.reduce((a, b) => a + b, 0) / Math.max(1, bucket.cpu.length),
    ),
    serverCpuMax: Math.round(Math.max(0, ...bucket.cpu)),
    serverMemoryMaxMb: Math.round(Math.max(0, ...bucket.rss)),
    dbCpuAvg: Math.round(
      bucket.dbCpu.reduce((a, b) => a + b, 0) / Math.max(1, bucket.dbCpu.length),
    ),
    generatorCpu: Math.round(((generator.user + generator.system) / 1e6 / seconds) * 100),
    healthP95: Math.round(percentile(bucket.latencies.get("health") ?? [], 95)),
    degraded: p95 > DEGRADED_P95_MS || errorRate > DEGRADED_ERROR_RATE,
  };
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: LOAD_DB_URL } } });
  console.log(
    `Load test: pool ${POOL}, ${STAGE_SECONDS} s per stage, stages ${STAGES.join(", ")} riders.`,
  );
  const { trips, zones } = await seedTrips(prisma);

  const server = startServer();
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${BASE}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    await sleep(500);
  }
  const stopSampling = sampleServer(server.pid!);

  // Cheap requests on a timer: their delay shows when the server itself is saturated.
  const health = setInterval(
    () => void call("health", "GET", "/health", { ip: "198.19.0.1" }),
    1000,
  );

  trips.forEach((trip, i) => {
    startDriver(trip, i);
    startTripRider(trip);
  });

  const results: StageResult[] = [];
  let degradedStages = 0;
  for (const target of STAGES) {
    bucket = newBucket();
    const toAdd = target - riderCount;
    // New riders arrive over the first 20 s of a stage, not all at once.
    for (let i = 0; i < toAdd; i++) setTimeout(() => void startRider(zones), (i / toAdd) * 20_000);
    await sleep(STAGE_SECONDS * 1000);
    const result = summarize(target);
    results.push(result);
    console.log(
      `${String(target).padStart(5)} riders | ${String(result.perSecond).padStart(4)} req/s | p50 ${result.p50} ms, p95 ${result.p95} ms, p99 ${result.p99} ms | ` +
        `errors ${result.errorRate}% (429: ${result.rateLimited}) | relay p95 ${result.relayP95} ms | ` +
        `server CPU ${result.serverCpuAvg}% (max ${result.serverCpuMax}%), ${result.serverMemoryMaxMb} MB | database CPU ${result.dbCpuAvg}% | load generator CPU ${result.generatorCpu}%` +
        (result.degraded ? "  << degraded" : ""),
    );
    if (Object.keys(result.refusals).length)
      console.log(`        not 2xx: ${JSON.stringify(result.refusals)}`);
    if (result.degraded && ++degradedStages >= 2) break;
  }

  running = false;
  clearInterval(health);
  stopSampling();
  for (const socket of sockets) socket.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await prisma.$disconnect();

  const out = path.join(os.tmpdir(), `campusride-loadtest-pool${POOL}.json`);
  writeFileSync(
    out,
    JSON.stringify({ pool: POOL, stageSeconds: STAGE_SECONDS, drivers: DRIVERS, results }, null, 2),
  );
  console.log(`Full results: ${out}`);
  process.exit(0);
}

void main();
