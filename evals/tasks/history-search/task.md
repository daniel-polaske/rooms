# Search a room's history

Clients can page a room's history by `seq`. Add a substring filter so a client can find
messages without downloading everything.

## Requirements

- `GET /api/rooms/:name/messages?q=<text>` returns only messages whose `body` contains
  `<text>`, **case-insensitively**. Ordering, `after` and `limit` behave exactly as
  without `q`; the 500-row cap still applies to rows returned.
- An empty or absent `q` means no filter (unchanged behaviour).
- `q` longer than **200 characters** is rejected with `400` and JSON
  `{ "error": "q too long", "max": 200 }`.
- The filter runs in SQLite (one query), not in JavaScript over a larger page.
- The WebSocket `sync` message is unchanged.

## Non-goals

Full-text indexes, ranking, highlighting.
