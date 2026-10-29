#!/usr/bin/env node
/**
 * Stage 2/5 drill: "kill a room mid-stream".
 *
 * Posts N messages to a room over HTTP while aborting the object every K
 * posts, then compares what was acknowledged with what SQLite holds.
 *
 * Pass criteria (invariants I2 and I3 from room.ts):
 *   - every acknowledged msg_id is present in history exactly once
 *   - no msg_id appears twice
 *   - seq values are strictly increasing in history
 *
 * Usage: node scripts/drill-kill.mjs [baseUrl] [room] [n] [killEvery]
 *   node scripts/drill-kill.mjs http://localhost:8787 drill 300 25
 *
 * Credentials come from .dev.vars (gitignored), never from argv:
 *   CHAOS_TOKEN              required for /chaos
 *   CF_ACCESS_CLIENT_ID      service token, when the URL is behind Access
 *   CF_ACCESS_CLIENT_SECRET
 */
import { readFileSync } from "node:fs";

const [base = "http://localhost:8787", room = "drill-" + Date.now().toString(36), N = "300", K = "25"] = process.argv.slice(2);
const n = Number(N), k = Number(K);

const vars = loadDevVars();
const token = vars.CHAOS_TOKEN ?? "dev";
const auth = {};
if (vars.CF_ACCESS_CLIENT_ID && vars.CF_ACCESS_CLIENT_SECRET) {
  auth["CF-Access-Client-Id"] = vars.CF_ACCESS_CLIENT_ID;
  auth["CF-Access-Client-Secret"] = vars.CF_ACCESS_CLIENT_SECRET;
}

function loadDevVars() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] !== "" && !(m[1] in process.env)) out[m[1]] = m[2];
    }
  } catch { /* no .dev.vars: fall back to the environment */ }
  return out;
}

const acked = new Map(); // msg_id -> seq
let retries = 0, errors = 0, resets = 0;

async function post(i) {
  const msg_id = `drill-${i}-${Math.random().toString(36).slice(2, 8)}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(`${base}/api/rooms/${room}/messages`, {
        method: "POST", headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ msg_id, author: "drill", body: `message ${i}` }),
      });
      if (r.status === 302 || r.status === 401 || r.status === 403) {
        console.error(`HTTP ${r.status} from ${base}: Access rejected the request. Set CF_ACCESS_CLIENT_ID/SECRET in .dev.vars.`);
        process.exit(2);
      }
      const j = await r.json();
      if (r.ok) { acked.set(msg_id, j.seq); return; }
      errors++;
      if (!j.retryable && r.status !== 500) throw new Error(`${r.status} ${JSON.stringify(j)}`);
    } catch (e) { errors++; }
    retries++;
    await new Promise((res) => setTimeout(res, 30 * attempt));
  }
  throw new Error(`gave up on ${msg_id}`);
}

async function kill() {
  resets++;
  await fetch(`${base}/api/rooms/${room}/chaos?mode=abort`, { method: "POST", headers: { "x-chaos-token": token, ...auth } }).catch(() => {});
}

console.log(`room=${room} n=${n} killEvery=${k} base=${base}`);
const t0 = Date.now();
const inflight = [];
for (let i = 0; i < n; i++) {
  inflight.push(post(i));
  if (i > 0 && i % k === 0) inflight.push(kill());
  if (inflight.length >= 20) { await Promise.all(inflight.splice(0)); }
}
await Promise.all(inflight);
const dt = Date.now() - t0;

// Read everything back.
const hist = [];
let after = 0;
for (;;) {
  const page = await (await fetch(`${base}/api/rooms/${room}/messages?after=${after}&limit=500`, { headers: auth })).json();
  if (!page.length) break;
  hist.push(...page); after = page.at(-1).seq;
}

const seen = new Map();
for (const m of hist) seen.set(m.msg_id, (seen.get(m.msg_id) ?? 0) + 1);
const missing = [...acked.keys()].filter((id) => !seen.has(id));
const dupes = [...seen.entries()].filter(([, c]) => c > 1).map(([id]) => id);
let monotonic = true;
for (let i = 1; i < hist.length; i++) if (hist[i].seq <= hist[i - 1].seq) monotonic = false;

console.log({ posted: n, acked: acked.size, inHistory: hist.length, resets, retries, errors, ms: dt });
console.log({ missingAcked: missing.length, duplicates: dupes.length, seqMonotonic: monotonic });
const pass = missing.length === 0 && dupes.length === 0 && monotonic;
console.log(pass ? "PASS: no acknowledged write lost, no duplicates, total order held" : "FAIL");
process.exit(pass ? 0 : 1);
