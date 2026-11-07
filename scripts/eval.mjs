#!/usr/bin/env node
/**
 * Eval runner: score an agent against the harness.
 *
 * For each task in evals/tasks.json:
 *   1. a disposable git worktree of --base (default HEAD) is created,
 *   2. the task's grader (evals/tasks/<id>/grader.feature) is copied into it as
 *      features/eval-<id>.feature, so the agent can see what "done" means,
 *   3. the agent command runs inside the worktree with the prompt on stdin
 *      (and in {prompt_file}); it has --timeout-min to finish,
 *   4. the harness grades the result:
 *        grader unchanged  · npm run gates  · acceptance --tags "not @eval"  · acceptance --tags @eval-<id>
 *      pass = all four.
 *
 * Usage
 *   node scripts/eval.mjs --agent 'claude -p --output-format json --permission-mode bypassPermissions'
 *   node scripts/eval.mjs --agent 'my-agent --prompt-file {prompt_file}' --tasks rate-limit,ws-presence
 *   node scripts/eval.mjs --baseline        # no agent: proves every grader FAILS on the base tree
 *
 * Options
 *   --agent <cmd>        shell command; {prompt_file} and {task} are substituted; prompt also on stdin
 *   --tasks a,b,c        subset of task ids (default: all)
 *   --baseline           skip the agent and grade the unchanged tree
 *   --base <ref>         git ref to start each worktree from (default: HEAD)
 *   --timeout-min <n>    agent time budget per task (default: 30)
 *   --keep               keep the worktrees under .eval-worktrees/ for inspection
 *
 * Output: reports/evals/<run>/results.json, summary.md, and per task the agent log,
 * gate logs and the diff. The summary is printed at the end.
 *
 * While it runs:
 *   tail -f reports/evals/<run>/<task>/agent.log            the agent, live
 *   git -C .eval-worktrees/<run>/<task> diff --stat         what it has changed so far
 *   ls reports/evals/<run>/<task>/                          which grading steps have finished
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const tasks = JSON.parse(readFileSync(path.join(root, "evals/tasks.json"), "utf8")).filter(
  (t) => !args.tasks || args.tasks.includes(t.id),
);
if (!tasks.length) die("no tasks selected");
if (!args.baseline && !args.agent) die("--agent <cmd> is required (or --baseline)");

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(root, "reports/evals", runId);
const wtRoot = path.join(root, ".eval-worktrees", runId);
mkdirSync(runDir, { recursive: true });
const base = args.base ?? "HEAD";
const baseSha = sh(["git", "rev-parse", base], root).stdout.trim();

console.log(`eval ${runId}: ${tasks.length} task(s), base ${base} (${baseSha.slice(0, 7)}), ${args.baseline ? "baseline" : `agent: ${args.agent}`}`);

const results = [];
for (const [i, task] of tasks.entries()) {
  const r = await runTask(task, i);
  results.push(r);
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${task.id.padEnd(22)} ${r.reason ?? ""}`);
}

const summary = summarize(results);
writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ run: runId, base: baseSha, agent: args.agent ?? null, baseline: !!args.baseline, results }, null, 2));
writeFileSync(path.join(runDir, "summary.md"), summary);
console.log(`\n${summary}\nreports: ${path.relative(root, runDir)}`);

if (args.baseline) {
  // A grader that passes on the base tree would pass for an agent that did nothing.
  const broken = results.filter((r) => r.task_ok);
  const unhealthy = results.filter((r) => !r.gates_ok || !r.regressions_ok);
  if (broken.length) die(`graders that pass on the base tree (not discriminating): ${broken.map((r) => r.id).join(", ")}`);
  if (unhealthy.length) die(`base tree does not pass its own gates: ${unhealthy.map((r) => r.id).join(", ")}`);
  console.log(`baseline healthy: ${results.length}/${results.length} graders fail on the base tree, gates and existing scenarios pass`);
}

// ------------------------------------------------------------------ one task

async function runTask(task, index) {
  const dir = path.join(runDir, task.id);
  mkdirSync(dir, { recursive: true });
  const wt = path.join(wtRoot, task.id);
  const taskDir = path.join(root, "evals/tasks", task.id);
  const grader = readFileSync(path.join(taskDir, "grader.feature"), "utf8");
  const graderHash = sha(grader);
  const result = { id: task.id, difficulty: task.difficulty, pass: false, reason: null };
  const t0 = Date.now();
  console.log(`  ..    ${task.id.padEnd(22)} worktree ${path.relative(root, wt)}`);

  try {
    sh(["git", "worktree", "add", "--detach", wt, base], root, { check: true });
    copyFileSync(path.join(root, ".dev.vars.example"), path.join(wt, ".dev.vars"));
    writeFileSync(path.join(wt, "features", `eval-${task.id}.feature`), grader);
    logged(dir, "setup", ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"], wt, { check: true });
    logged(dir, "setup", ["npm", "run", "types"], wt, { check: true, append: true });

    if (!args.baseline) {
      const prompt = buildPrompt(task, wt);
      const promptFile = path.join(dir, "prompt.md");
      writeFileSync(promptFile, prompt);
      const agent = await runAgent(args.agent.replaceAll("{prompt_file}", promptFile).replaceAll("{task}", task.id), prompt, wt, dir);
      Object.assign(result, { agent_exit: agent.code, agent_minutes: +(agent.ms / 60000).toFixed(1), cost_usd: agent.cost, timed_out: agent.timedOut });
    }

    // --- grade ----------------------------------------------------------
    const after = readFileSync(path.join(wt, "features", `eval-${task.id}.feature`), "utf8");
    result.grader_unchanged = sha(after) === graderHash;
    result.gates_ok = logged(dir, "gates", ["npm", "run", "gates"], wt).status === 0;
    const port = String(8900 + index * 2);
    result.regressions_ok = logged(dir, "regressions", ["node", "scripts/acceptance.mjs", "--tags", "not @eval"], wt, { env: { PORT: port } }).status === 0;
    const taskRun = logged(dir, "task", ["node", "scripts/acceptance.mjs", "--tags", `@eval-${task.id}`], wt, { env: { PORT: String(+port + 1) } });
    result.task_ok = taskRun.status === 0;
    result.task_scenarios = scenarioCounts(readFileSync(path.join(dir, "task.log"), "utf8"));

    sh(["git", "add", "-A", "-N", "."], wt);
    const numstat = sh(["git", "diff", "--numstat", "--", ".", `:!features/eval-${task.id}.feature`], wt).stdout.trim();
    result.diff = diffStats(numstat);
    writeFileSync(path.join(dir, "diff.patch"), sh(["git", "diff", "--", ".", `:!features/eval-${task.id}.feature`], wt).stdout);

    result.pass = result.grader_unchanged && result.gates_ok && result.regressions_ok && result.task_ok;
    result.reason = result.pass ? null
      : !result.grader_unchanged ? "grader was edited"
      : !result.gates_ok ? "gates failed"
      : !result.regressions_ok ? "existing scenarios regressed"
      : `task scenarios: ${result.task_scenarios.passed}/${result.task_scenarios.total} passed`;
  } catch (e) {
    result.reason = `runner error: ${e.message}`;
  } finally {
    result.total_minutes = +((Date.now() - t0) / 60000).toFixed(1);
    if (!args.keep) sh(["git", "worktree", "remove", "--force", wt], root);
    sh(["git", "worktree", "prune"], root);
  }
  return result;
}

function buildPrompt(task, wt) {
  const spec = readFileSync(path.join(root, "evals/tasks", task.id, "task.md"), "utf8");
  return `You are working in a disposable git worktree of the \`rooms\` repository at ${wt}.
Read HARNESS.md first, then implement the task below.

Definition of done, all four:
1. \`features/eval-${task.id}.feature\` passes: \`npm run acceptance -- --tags @eval-${task.id}\`. Do not edit that file.
2. \`npm run gates\` passes: types, lint caps, dependency rules, unit tests with the coverage floors.
3. \`npm run acceptance -- --tags "not @eval"\` still passes: nothing existing regresses.
4. No floor in HARNESS.md, vitest.config.ts, eslint.config.js or .dependency-cruiser.cjs is lowered.

Add unit tests for what you build (test/*.test.ts, run inside workerd). Follow the conventions
in the code. Do not commit; leave the changes in the working tree. Do not edit the task text.

---

${spec}`;
}

async function runAgent(cmd, prompt, cwd, dir) {
  const t0 = Date.now();
  const timeoutMs = (args.timeoutMin ?? 30) * 60_000;
  // Streamed to agent.log as it happens, so `tail -f` shows the agent working.
  const log = createWriteStream(path.join(dir, "agent.log"));
  const out = [];
  const child = spawn("sh", ["-c", cmd], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, EVAL_TASK: path.basename(dir), CI: "1" } });
  const keep = (d) => { out.push(d); log.write(d); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.stdin.end(prompt);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? -1)));
  clearTimeout(timer);
  const text = Buffer.concat(out).toString();
  log.end();
  return { code, ms: Date.now() - t0, cost: findCost(text), timedOut };
}

/** Claude Code's `--output-format json` ends with a result object carrying total_cost_usd; other agents may print their own. */
function findCost(text) {
  const m = [...text.matchAll(/"total_cost_usd"\s*:\s*([0-9.]+)/g)].pop();
  return m ? +m[1] : null;
}

// ------------------------------------------------------------------ helpers

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") o.agent = argv[++i];
    else if (a === "--tasks") o.tasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--baseline") o.baseline = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--base") o.base = argv[++i];
    else if (a === "--timeout-min") o.timeoutMin = Number(argv[++i]);
    else die(`unknown option ${a}`);
  }
  return o;
}

function sh(cmd, cwd, { check = false, env = {} } = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  if (check && r.status !== 0) throw new Error(`${cmd.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").slice(-2000)}`);
  return r;
}

function logged(dir, name, cmd, cwd, { check = false, env = {}, append = false } = {}) {
  const r = sh(cmd, cwd, { env });
  const file = path.join(dir, `${name}.log`);
  const text = `$ ${cmd.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}\n[exit ${r.status}]\n`;
  writeFileSync(file, append && existsSync(file) ? readFileSync(file, "utf8") + text : text);
  if (check && r.status !== 0) throw new Error(`${name}: ${cmd.join(" ")} failed (${r.status}); see ${path.relative(root, file)}`);
  return r;
}

function scenarioCounts(log) {
  const m = log.match(/(\d+) scenarios? \(([^)]*)\)/);
  if (!m) return { total: 0, passed: 0 };
  const passed = m[2].match(/(\d+) passed/);
  return { total: +m[1], passed: passed ? +passed[1] : 0 };
}

function diffStats(numstat) {
  let files = 0, ins = 0, del = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d] = line.split("\t");
    files++; ins += +a || 0; del += +d || 0;
  }
  return { files, insertions: ins, deletions: del };
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

function summarize(results) {
  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  const rows = results.map((r) => [
    r.id, r.difficulty, r.pass ? "pass" : "FAIL",
    r.grader_unchanged === false ? "edited" : "ok",
    r.gates_ok ? "ok" : "fail",
    r.regressions_ok ? "ok" : "fail",
    r.task_scenarios ? `${r.task_scenarios.passed}/${r.task_scenarios.total}` : "-",
    r.agent_minutes ?? "-", r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : "-",
    r.diff ? `${r.diff.files}f +${r.diff.insertions}/-${r.diff.deletions}` : "-",
    r.reason ?? "",
  ]);
  const header = ["task", "difficulty", "result", "grader", "gates", "regressions", "scenarios", "agent min", "cost", "diff", "note"];
  const table = [header, header.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
  const byDifficulty = ["easy", "medium", "hard"].map((d) => {
    const g = results.filter((r) => r.difficulty === d);
    return g.length ? `${d} ${g.filter((r) => r.pass).length}/${g.length}` : null;
  }).filter(Boolean).join(" · ");
  return `## Eval ${runId}\n\n${args.baseline ? "**Baseline (no agent).**" : `Agent: \`${args.agent}\``}\n\n**${passed}/${results.length} passed** (${byDifficulty})${cost ? ` · total cost $${cost.toFixed(2)}` : ""}\n\n${table}\n`;
}

function die(msg) {
  console.error(`eval: ${msg}`);
  process.exit(1);
}
