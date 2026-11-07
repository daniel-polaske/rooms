# Per-room idle timeout

Every room archives after the global `IDLE_MS`. Let an operator set a different idle
timeout for one room, persisted in the room itself.

## Requirements

- `PUT /api/rooms/:name/settings`, guarded by the shared secret (`x-chaos-token`): JSON body
  `{ "idle_ms": <integer> }`, valid range **1000 … 604800000** (one second to seven days).
  Responds `200` with `{ "idle_ms": <value> }`. `403` without the secret; `400` with
  `{ "error": "bad idle_ms" }` for anything invalid or missing.
- The value is persisted in the room's `meta` table (like `name`), so it survives evictions
  and resets, and it is read by the same code path the alarm uses today.
- If the room has messages, setting `idle_ms` reschedules the pending alarm to
  `now + idle_ms` immediately, so lowering it takes effect without waiting for a post.
- `GET /api/rooms/:name` (`status()`) gains `"idle_ms"`: the effective value, override or
  the `IDLE_MS` default.
- Each post keeps pushing the alarm back by the effective value, as today.

## Non-goals

Clearing the override, per-room grace, changing the Workflow.
