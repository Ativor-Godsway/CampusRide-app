/**
 * Sends one test message to the server's Sentry project, to check SENTRY_DSN
 * is right (DEPLOY.md, "Monitoring", step 2). Touches no database.
 *
 *   SENTRY_DSN="https://…" npm run sentry:test --workspace=apps/server
 */
import { flushMonitoring, initMonitoring, reportMessage } from "../lib/monitoring";

async function main() {
  if (!initMonitoring({ ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" })) {
    console.error(
      'SENTRY_DSN is not set. Run: SENTRY_DSN="<the server project\'s DSN>" npm run sentry:test --workspace=apps/server',
    );
    process.exit(1);
  }
  reportMessage("Test message from the CampusRide server: Sentry is set up", {
    level: "warning",
    tags: { alert: "sentry_test" },
  });
  await flushMonitoring(5000);
  console.log(
    "Sent. It should appear under Issues in the server's Sentry project within a minute.",
  );
}

void main();
