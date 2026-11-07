# Shard the directory

`DirectoryDO` is the deliberate singleton: every post in every room becomes one row write
in one object, and Stage 5's hot-singleton drill shows what happens under a burst. Apply
the fix the README names: shard by `hash(room) % N`.

## Requirements

- `N` comes from the `DIRECTORY_SHARDS` var (`wrangler.jsonc` `vars`, default `"4"`).
  Shard objects are named `shard-<i>` for `i` in `0 … N-1`. The shard for a room is
  `fnv1a32(room) % N` (FNV-1a, 32-bit, over the UTF-8 bytes of the name); put the hash in
  one exported function with a unit test that pins known values.
- The Queue consumer groups each batch's events by shard and calls `bump()` once per
  shard. Ack/retry semantics per message are unchanged.
- `ArchiveWorkflow`'s `mark` step calls `archive()` on the room's shard.
- `GET /api/rooms` fans out to every shard and returns the merged list, ordered by
  `last_ts` descending then `name` ascending, honouring `limit` (default 100, max 500).
- `GET /api/directory` returns
  `{ "shards": N, "rooms": <total>, "per_shard": [{ "shard": i, "id": …, "incarnation": …, "rooms": … }] }`.
- Fan-out requests to shards run concurrently (`Promise.all`), not in sequence.
- `DirectoryDO`'s own code is unchanged apart from what the above strictly needs; the
  sharding lives in the Router and a small shared helper module. Add the dependency rule
  that keeps it that way.

## Non-goals

Re-sharding existing data, a global ordering across shards beyond the merge, pagination.
