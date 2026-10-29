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

- [ ] Zero Trust -> Access -> Applications -> Self-hosted; domain = workers.dev `rooms.praedormitium`
- [ ] Allow policy: Emails -> your address (One-time PIN IdP needs no setup)
- [ ] Service Auth -> create a Service Token; Service Auth policy including it
- [ ] drills: send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers (add to `drill-kill.mjs` via env)
- [ ] Router: verify `Cf-Access-Jwt-Assertion` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
      and the app AUD; gate on an `ACCESS_AUD` var so local dev keeps working; log caller email on `room.post`

## Stage 4 (instrumentation)

- [ ] saved Workers Logs queries: `event = "room.start"`, `event = "queue.retry"`, `event = "wf.step"`
- [ ] confirm `trace_id` follows one message Router -> RoomDO -> Queue -> DirectoryDO in the dashboard
- [ ] enable Workers Traces (check current config key) and compare spans with the hand-carried trace
