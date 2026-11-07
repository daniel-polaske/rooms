#!/usr/bin/env node
/**
 * Acceptance gate: boot `wrangler dev` (local, no account needed), wait until
 * it answers, run the Gherkin features against it, tear it down.
 *
 *   npm run acceptance              # local wrangler dev on a free port
 *   BASE=https://... npm run acceptance:remote   # against a deployed URL (needs .dev.vars Access token)
 *
 * Exit code is cucumber's. Requires .dev.vars (copy .dev.vars.example):
 * the archive scenario relies on its short ARCHIVE_GRACE.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const port = process.env.PORT ?? "8799";
const base = process.env.BASE ?? `http://localhost:${port}`;
const external = !!process.env.BASE;

if (!existsSync(new URL("../.dev.vars", import.meta.url))) {
  console.error("acceptance: .dev.vars is missing. `cp .dev.vars.example .dev.vars` first.");
  process.exit(2);
}

async function answering() {
  try { return (await fetch(`${base}/api/directory`)).ok; } catch { return false; }
}

let dev = null;
if (!external) {
  // Never test against something we did not start: a stale server on the port
  // would make the run meaningless.
  if (await answering()) {
    console.error(`acceptance: something is already serving ${base}. Stop it (a previous wrangler dev?) or set PORT.`);
    process.exit(2);
  }
  // detached: wrangler spawns workerd; killing the group takes both down.
  dev = spawn("npx", ["wrangler", "dev", "--port", port, "--ip", "127.0.0.1", "--show-interactive-dev-session=false"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG: "warn" },
  });
  // The drills inject failures on purpose, so wrangler's stderr is noisy by
  // design. Keep the tail and show it only when something actually fails
  // (or with ACCEPTANCE_VERBOSE=1).
  const verbose = !!process.env.ACCEPTANCE_VERBOSE;
  const keep = (d) => { devLog.push(...String(d).split("\n")); if (devLog.length > 400) devLog.splice(0, devLog.length - 400); };
  dev.stdout.on("data", (d) => { keep(d); if (verbose) process.stdout.write(`[wrangler] ${d}`); });
  dev.stderr.on("data", (d) => { keep(d); if (verbose) process.stderr.write(`[wrangler] ${d}`); });
  dev.on("exit", (code) => { if (code !== null && code !== 0 && !stopping) { console.error(`wrangler dev exited with ${code}`); dumpDevLog(); process.exit(1); } });
}
let stopping = false;
const devLog = [];
function dumpDevLog() {
  if (!devLog.length) return;
  console.error("--- wrangler dev output (tail) ---");
  console.error(devLog.filter((l) => l.trim()).join("\n"));
}

async function waitForReady(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await answering()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${base} did not become ready within ${ms} ms`);
}

function stop() {
  stopping = true;
  if (dev && dev.exitCode === null) {
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
process.on("SIGINT", () => { stop(); process.exit(130); });
process.on("SIGTERM", () => { stop(); process.exit(143); });

try {
  await waitForReady(60_000);
  console.log(`acceptance: ${base} is up`);
  const code = await new Promise((resolve) => {
    const cuke = spawn("npx", ["cucumber-js", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, BASE: base } });
    cuke.on("exit", (c) => resolve(c ?? 1));
  });
  stop();
  if (code !== 0) dumpDevLog();
  process.exit(code);
} catch (e) {
  console.error(`acceptance: ${e.message}`);
  stop();
  dumpDevLog();
  process.exit(1);
}
