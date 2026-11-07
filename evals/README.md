# Evals

The harness answers "is this change correct?" for one change. An eval answers a different
question: "how good is the process that produces changes?" — an agent, a model, a prompt,
a harness configuration. A test is a yes/no on a fixed artifact; an eval is a rate over a
task set, because the process is not deterministic and one run proves nothing.

Here the two are the same machinery pointed at different things: **the harness is the
grader.** An agent passes a task when the code it leaves behind would merge.

## The task set

Ten feature requests against `rooms`, each written the way a person would hand it to an
engineer: context, requirements, non-goals. Each ships with a Gherkin grader that defines
"done" from the outside, over HTTP and WebSockets, with no reference to how it is built.

| task | difficulty | exercises |
| --- | --- | --- |
| message-size | easy | one constraint, two entry points (HTTP and socket) |
| history-search | easy | a query change that must stay in SQLite and compose with paging |
| author-stats | easy | a new RPC method and route, one aggregate query |
| rate-limit | medium | per-author state inside the single-threaded object, a config var |
| delete-message | medium | a schema migration, a broadcast, total order preserved |
| room-list-pagination | medium | keyset pagination with a backward-compatible response |
| ws-presence | medium | the hibernation API, plus an existing off-by-one to fix |
| export-ndjson | medium | streaming a transform over an R2 body |
| idle-override | hard | persisted per-object settings and alarm rescheduling |
| directory-sharding | hard | the README's Stage 5 lesson: shard the singleton, fan out, merge |

`tasks.json` is the index; `tasks/<id>/task.md` is the prompt; `tasks/<id>/grader.feature` is
the acceptance test. Graders are tagged `@eval @eval-<id>` and live outside `features/` so
the normal acceptance run never sees them.

## What a pass is

For each task the runner (`scripts/eval.mjs`) creates a disposable git worktree, copies the
grader in as `features/eval-<id>.feature` so the agent can read what done means, runs the
agent inside the worktree, and then grades:

1. **grader unchanged** — the classic cheat is editing the test; the hash has to match
2. **`npm run gates`** — types, lint caps, dependency rules, unit tests with coverage floors
3. **`acceptance --tags "not @eval"`** — every pre-existing scenario still passes
4. **`acceptance --tags @eval-<id>`** — the task's scenarios pass

All four or nothing. The runner also records wall time, cost (when the agent reports it),
and the size of the diff, because a pass that took 40 minutes and 900 lines is a different
result from one that took 6 and 80.

## Running

```sh
npm run eval:baseline
```

No agent. Grades the unchanged tree and insists that **every grader fails** and every
worktree passes its own gates. Run it after adding or changing a task: a grader that passes
on the base tree would pass for an agent that did nothing.

```sh
npm run eval -- --agent 'claude -p --output-format json --permission-mode bypassPermissions'
```

The agent command runs with the worktree as its working directory and the prompt on stdin;
`{prompt_file}` and `{task}` in the command are substituted. Any agent that can take a
prompt and edit files works. The worktree is disposable, which is why the agent can run
with its permission prompts off; it never touches your checkout.

```sh
npm run eval -- --agent '…' --tasks rate-limit,ws-presence --timeout-min 20 --keep
```

`--keep` leaves the worktrees under `.eval-worktrees/` for inspection. Reports go to
`reports/evals/<run>/`: `results.json`, `summary.md`, and per task the prompt, the agent's
output, every gate's log, and `diff.patch`.

## Reading a result

- **Pass rate by difficulty** is the headline. Compare it across runs that change one thing:
  the model, the harness floors, the prompt preamble in `scripts/eval.mjs`, the task text.
- **One run is a sample.** Run the set three times before believing a difference of one task.
- **Failure reason** matters more than the count. "grader was edited" is a process problem.
  "gates failed" with passing scenarios means the agent can build the feature but not to the
  standard; read `gates.log` to see which floor. "existing scenarios regressed" means it
  broke something it did not touch on purpose.
- **Cost and diff size** are the efficiency axis. The 20X claim is a ratio of these to what a
  person would take.

## Adding a task

1. Write `tasks/<id>/task.md` as you would brief a colleague. State non-goals.
2. Write `tasks/<id>/grader.feature`, tagged `@eval @eval-<id>`, using the steps in
   `features/steps/` (add generic steps there, never task-specific ones in the grader).
3. Add it to `tasks.json` with a difficulty.
4. `npm run eval:baseline -- --tasks <id>` must report that it fails, for the right reason
   (read `task.log`: an assertion on behaviour, never an undefined step).

## What this does not measure

Whether the feature was worth building, whether the code is pleasant to work in beyond what
the caps enforce, and whether the agent's explanation of its work was honest. Those are still
yours. The eval tells you how often the process produces something that would merge, and what
it costs. That is the number to improve.
