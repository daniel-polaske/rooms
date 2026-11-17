# rooms

One Durable Object per chat room. A learning POC for the "distributed singleton with SQLite"
model (Workers + Durable Objects + Queues + Workflows), built to run on the Cloudflare Free plan
and to be broken on purpose.

Companion doc with the full stage plan, instrumentation guide and troubleshooting playbook:
*Distributed Singletons on the Free Plan*.

## Layout

```
src/index.ts      Router Worker (stateless) + Queue consumer
src/room.ts       RoomDO: SQLite messages, hibernating WebSockets, alarm, chaos()
src/directory.ts  DirectoryDO: the deliberate singleton (room index + counters)
src/archive.ts    ArchiveWorkflow: export -> R2, durable sleep, verify etag, mark (checkpointed steps)
src/log.ts        structured JSON logging + hand-carried trace context
public/index.html minimal client: msg_id per post, resync after reconnect, heartbeat
test/             unit + integration tests, run inside workerd against the real bindings
features/         Gherkin acceptance scenarios, run over HTTP against wrangler dev
scripts/drill-kill.mjs  Stage 2/5 drill: kill the room mid-stream, verify invariants
scripts/acceptance.mjs  boots wrangler dev and runs the features against it
scripts/eval.mjs        scores an agent against the harness on the tasks in evals/
evals/            ten feature tasks with Gherkin graders: the eval set (evals/README.md)
HARNESS.md        the gates, their floors, and the ratchet rule
```

## Run

```sh
npm ci
cp .dev.vars.example .dev.vars     # CHAOS_TOKEN=dev for local
npm run types                      # generates worker-configuration.d.ts from wrangler.jsonc
npm run gates                      # types, lint, dependency rules, tests + coverage
npm run acceptance                 # the Gherkin scenarios against a local wrangler dev
npm run dev                        # http://localhost:8787
```

Nothing merges unless the gates in [HARNESS.md](HARNESS.md) pass; CI runs them on every pull request.

In another terminal:

```sh
B=http://localhost:8787
curl -s $B/api/rooms/lobby | jq                     # status: id, incarnation, counts
curl -s $B/api/rooms/lobby/describe -H 'x-chaos-token: dev' | jq   # the object on itself (below)
curl -s -XPOST $B/api/rooms/lobby/messages -d '{"author":"dan","body":"hi"}' | jq
curl -s "$B/api/rooms/lobby/messages?after=0" | jq
curl -s -XPOST "$B/api/rooms/lobby/chaos?mode=abort" -H 'x-chaos-token: dev'
curl -s $B/api/rooms/lobby | jq .incarnation        # changed: the object was reset
npm run drill:kill -- $B lobby 300 25               # expect PASS
```

Open http://localhost:8787 in two browser tabs, join the same room, type, then press **kill room**
and watch the event pane: `object RESET: incarnation a -> b`, then `history +N` fills the gap.

## Know thyself

`GET /api/rooms/:name/describe` with header `x-chaos-token` asks the object what it is. The answer
comes from inside (`describe()` in `src/room.ts`), writes nothing, and costs the same however large
the room is: one row read on workerd. The Router does not `setName` first, so asking does not change
the answer.

| field | from | what it tells you |
| --- | --- | --- |
| `class`, `id` | `ctx.id.toString()` | which object: 64 hex digits, a function of the name |
| `id_name` | `ctx.id.name` | the name the caller addressed; `null` for an id that was not made from a name |
| `name` | the `meta` table | the name the room was told and remembers; empty until a route names it |
| `incarnation`, `started_at` | minted in the constructor | which life this is; both are new after every reset |
| `sockets` | `ctx.getWebSockets()` | who is attached |
| `alarm_at` | `ctx.storage.getAlarm()` | what is scheduled, in ms since the epoch, or `null` |
| `bookmark` | `ctx.storage.getCurrentBookmark()` | the point in time the database is at; `null` where the runtime has no such method |
| `db_bytes` | `ctx.storage.sql.databaseSize` | what it owns, in bytes |
| `max_seq` | `SELECT MAX(seq)` | the last write; one row read |
| `tables` | `PRAGMA table_list` | every table in this object's file, the runtime's own included; no rows read |
| `rows_read` | the two cursors' `rowsRead` | the meter: what asking cost |

`status()` counts messages with `COUNT(*)`, which reads one row per message (measured: `rowsRead`
equals the message count), so poll `describe`, not `status`, on a big room.

The same facts from outside, locally: the object's database is the file
`.wrangler/state/v3/do/rooms-RoomDO/<id>.sqlite`. Open it with `sqlite3` and compare `db_bytes`
with its size and `alarm_at` with row 1 of `_cf_METADATA` (nanoseconds).

On celld 0.6.3 (`celld dev`, after removing the `observability` key it rejects from the config) the
same call answers with `bookmark: null`, celld's own tables in `tables`, a different `id` for the same
name, and `rows_read: 13`, still constant as the room grows. The file is
`.celld/dev/runtime/RoomDO:<id>/ltx/e1/db.sqlite`.

## Stage 3: alarm -> Workflow -> R2

With `.dev.vars` from the example (`IDLE_MS=15000`, `ARCHIVE_GRACE=5 seconds`):

```sh
for i in 1 2 3; do curl -s -XPOST $B/api/rooms/a/messages -d "{\"body\":\"m$i\"}"; done
sleep 16                                             # the room's alarm fires on its own
curl -s $B/api/archives/archive-a-3-idle | jq        # export -> sleep -> verify -> mark
curl -s $B/api/archives/archive-a-3-idle/body | jq   # the JSON object read back from R2
curl -s $B/api/rooms | jq                            # archived: 1, archive_key set
```

Or skip the wait: `curl -XPOST $B/api/rooms/a/archive -H 'x-chaos-token: dev'` (returns 202 and the
instance id). The instance id is `archive-<room>-<max_seq>-<reason>`, so triggering twice at the same
point starts one instance; post a message and the id changes.

Replay drill: start an archive on a room with a few hundred messages, immediately `chaos?mode=abort`
the room. The Workflow's `export` step fails, retries after 10 s, and completes; `verify` and `mark`
run once. Count `"step":"export"` lines in the log to see the retry.

## Deploy

```sh
npx wrangler login
npx wrangler queues create room-events
npx wrangler queues create room-events-dlq
npx wrangler r2 bucket create rooms-archives
npx wrangler secret put CHAOS_TOKEN
npm run deploy
npm run tail            # live invocation stream; keep open during drills
```

Workflows and Durable Objects are created from `wrangler.jsonc` on first deploy. Production keeps
`IDLE_MS` at 24 h and `ARCHIVE_GRACE` at 1 hour (set in `wrangler.jsonc` `vars`).

## Chaos modes

`POST /api/rooms/:name/chaos?mode=<throw|abort|cpu|hang>` with header `x-chaos-token`.

| mode  | what fails                                | what you see                                        |
| ----- | ----------------------------------------- | --------------------------------------------------- |
| throw | one request                               | 500; same incarnation afterwards                    |
| abort | the object (in-memory state, sockets)     | 500; new incarnation; SQLite intact; clients resync |
| cpu   | the invocation, at the CPU limit          | error 1102 / `exceededCpu` in tail (deployed only)  |
| hang  | nothing visibly; the request never returns | the wedged object: silence                          |

## Invariants the drills test

- **I1** total order per room: `seq` as seen by any client is a prefix of SQLite's sequence
- **I2** no acknowledged write is lost across a reset
- **I3** `post()` is idempotent on `msg_id`

Note that `seq` is monotonic but not dense: a duplicate post still consumes an AUTOINCREMENT
rowid, so gaps (1, 3, 4, 6 ...) are normal and are not lost messages. The drill checks for lost
*msg_ids*, never for contiguous seqs.

Try removing `OR IGNORE` from the INSERT in `room.ts` and re-running the drill: the retry
wrapper in the Router will double-post. That is the Stage 2 lesson in one line.

## Free plan notes

100k requests/day shared by Workers and DOs; 10 ms CPU per invocation; 5M DO rows read/day;
Queue messages retained 24 h; Workers Logs 200k events/day for 3 days (changing 1 Dec 2026).
Count rows, not requests: `history()` caps `limit` at 500 for this reason.
