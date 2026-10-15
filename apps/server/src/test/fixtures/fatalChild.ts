/**
 * Run as its own process by lib/fatal.test.ts: installs the crash handlers,
 * then fails in the way argv[2] names. The process must log the failure
 * (scrubbed) and exit 1 — never print "still running".
 */
import { installFatalHandlers } from "../../lib/fatal";

installFatalHandlers();

if (process.argv[2] === "rejection") {
  void Promise.reject(new Error("lost the ride for +233548617146"));
} else if (process.argv[2] === "exception") {
  setTimeout(() => {
    throw new Error("crashed on 0548617146");
  }, 0);
}

setTimeout(() => {
  process.stdout.write("still running\n");
}, 1500);
