# Rate-limit posts per author

One client can currently post as fast as the Router will accept. Add a per-author limit
inside the room, where the single thread makes counting trivial.

## Requirements

- Per `(room, author)`: at most **60 accepted posts per rolling 60 seconds**, over HTTP
  and over the WebSocket alike. A post that is rejected does not count. A duplicate
  (`msg_id` already seen) counts as a post.
- Over HTTP the 61st post gets `429` with a `retry-after` header (integer seconds, at least
  1) and JSON `{ "error": "rate limited", "retry_after": <seconds> }`.
- Over the WebSocket, reply to that socket only with
  `{ "type": "error", "msg_id": <msg_id>, "reason": "rate limited", "retry_after": <seconds> }`.
- The limit is read from the `POST_LIMIT_PER_MINUTE` var (`wrangler.jsonc` `vars`,
  default `"60"`), like `IDLE_MS`.
- Counters may live in memory and may reset with the object; that is acceptable and
  should be stated in a comment.
- Other authors in the same room are unaffected.

## Non-goals

Per-IP limits, global limits, persistence of counters.
