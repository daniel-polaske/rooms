# The harness

Code in this repository is written by agents and merged by a person who does not read it
line by line. That only works if the constraints are strong enough that a wrong change
cannot get through. This file is the list of those constraints, the numbers they are set
to, and the rule for changing the numbers.

The spec is `README.md` ("Invariants the drills test") and `features/*.feature`. The harness
is what turns the spec into a merge decision.

## Gates

| Gate | Command | What it catches | Floor (2026-11-06) |
| --- | --- | --- | --- |
| Types | `npm run check` | a binding, a shape or a contract that drifted | zero errors |
| Lint: shape | `npm run lint` | a function nobody can hold in their head | complexity ≤ 15, ≤ 60 lines/function, ≤ 30 statements, depth ≤ 4, ≤ 5 params, ≤ 260 lines/module, no `any` |
| Dependency rules | `npm run depcruise` | the object boundary leaking into an import | zero violations ([`.dependency-cruiser.cjs`](.dependency-cruiser.cjs)) |
| Unit + integration | `npm run test:coverage` | behaviour, against real SQLite DOs, R2, Queue, Workflow in workerd | lines 90 · statements 88 · branches 82 · functions 90 |
| Acceptance | `npm run acceptance` | the invariants over HTTP, under fault injection, against `wrangler dev` | every scenario |
| Mutation | `npm run mutate` | tests that pass whether or not the code is right | score ≥ 60 (measured 67.3) |

`npm run gates` runs the first four. CI (`.github/workflows/harness.yml`) runs all six:
`gates` and `acceptance` on every pull request and push, `mutation` incrementally on pull
requests and in full every Monday.

## The ratchet

Every number above is a floor measured at the moment it was set. The rule:

1. A number may go **up** in any pull request that earns it. Raise it to just under the new
   measurement and say so in the commit message.
2. A number never goes **down** to let a change through. If a change needs a lower floor,
   the change is wrong, or the floor was never a real constraint. Either way, the discussion
   happens in the pull request, in the open, with the number in the title.
3. A cap that the current code fails is not set lower to make it pass; the code is refactored
   under the tests until it passes. `route()` in `src/index.ts` was the first: complexity 44,
   refactored into handlers at ≤ 15 with the suite as the safety net.

## What to raise next

Measured on 2026-11-06, in the order they pay:

- **Mutation 67 → 80.** 80 of the 182 survivors are `log()` calls: no test asserts the
  structured events. They are the observability contract (`room.post`, `queue.retry`,
  `wf.step`, `http.denied`) that the Stage 4 saved queries will search for, so assert them
  on every state-changing path. The rest are mostly conditionals and literals in retry and
  metadata config; `reports/mutation/index.html` lists every one.
- **Branches 82 → 90.** `archive.ts` is at 64%: the `reason` default and the grace fallback.
- **Coverage of the untestable.** `chaos cpu` and `chaos hang` cannot run in-process. They
  are exercised against the deployed Worker (TODO.md); keep it that way, do not fake them.

## Working with agents under the harness

- Write the Gherkin scenario first. If you cannot say what "correct" means in a scenario,
  the agent cannot either.
- Let the agent write the code and the unit tests. Read the scenario and the diff of
  `features/`, not the implementation.
- When a gate fails, hand the failure to the agent verbatim. Do not lower the gate.
- When something slips through to production, the first fix is a gate, the second is the code.

## Local setup

```sh
npm ci
cp .dev.vars.example .dev.vars   # the archive scenario relies on its short ARCHIVE_GRACE
npm run gates
npm run acceptance
npm run mutate                   # ~12 min at concurrency 2; report in reports/mutation/
```
