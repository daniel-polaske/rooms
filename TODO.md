# TODO

Deployed at https://rooms.praedormitium.workers.dev (version 3153efc7, 29 Oct 2026).

## Run the deployed drills

Keep `npm run tail` open in a second terminal. `B=https://rooms.praedormitium.workers.dev`, `T=<CHAOS_TOKEN>`.

- [ ] `curl -s $B/api/rooms/lobby | jq` and note `id`, `incarnation`
- [ ] post, duplicate post (same `msg_id`), history
- [ ] `chaos?mode=abort` -> expect `"retryable": true` (differs from local) and `router.retry` in tail
- [ ] `chaos?mode=cpu` -> expect error 1102; `exceededCpu` in tail
- [ ] `CHAOS_TOKEN=$T node scripts/drill-kill.mjs $B drill1 300 25` -> PASS; compare `retries` with local
- [ ] `curl -s $B/api/rooms | jq` after ~10 s -> queue consumer updated the directory
- [ ] two browser tabs, same room, **kill room**, watch the event pane
- [ ] manual archive: `POST /api/rooms/lobby/archive`, poll `/api/archives/<id>`, read `/body` from R2
      (production grace is 1 hour; set `ARCHIVE_GRACE` shorter in the dashboard vars to drill it)

## Cleanup

- [ ] `wrangler.jsonc`: remove the duplicate `rooms_archives` binding the `r2 bucket create` prompt added; commit

## Put it behind Access

Use a hostname-based application, not the per-Worker toggle: Worker-level Access
returns 403 on WebSocket upgrades and does not pass identity through the static-assets router.

- [x] Zero Trust -> Access -> Applications -> Self-hosted; domain = workers.dev `rooms.praedormitium`
- [x] Allow policy: Emails -> your address (One-time PIN IdP needs no setup)
- [x] Service Auth -> create a Service Token; Service Auth policy including it
- [x] drills: send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers (read from `.dev.vars`)
- [x] Router: verify `Cf-Access-Jwt-Assertion` (src/access.ts, `npm run test:access`); `caller` on every http log line
- [ ] after deploy: `curl` with the service token -> 200; without -> 302 from Access (never reaches the Worker);
      a request with a forged/expired JWT would get 401 `http.denied` from the Worker itself

## Stage 4 (instrumentation)

- [ ] saved Workers Logs queries: `event = "room.start"`, `event = "queue.retry"`, `event = "wf.step"`
- [ ] confirm `trace_id` follows one message Router -> RoomDO -> Queue -> DirectoryDO in the dashboard
- [ ] enable Workers Traces (check current config key) and compare spans with the hand-carried trace
