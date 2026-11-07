# Paginate the room list

`GET /api/rooms` returns the most recently active rooms, capped. Add cursor pagination so a
client can walk the whole directory without changing the response shape existing clients
rely on.

## Requirements

- `GET /api/rooms?limit=N` returns at most `N` rooms (default 100, max 500) as the same
  bare JSON array as today, ordered by `last_ts` descending, then `name` ascending so the
  order is total and stable.
- When more rooms follow, the response carries an `x-next-cursor` header with an opaque
  cursor. `GET /api/rooms?limit=N&cursor=<that>` returns the next page. The last page has
  no `x-next-cursor` header.
- Walking the pages yields every room exactly once, even while rooms are being updated
  (keyset pagination on `(last_ts, name)`, not `OFFSET`).
- A malformed cursor: `400` with JSON `{ "error": "bad cursor" }`.
- `GET /api/rooms` with no parameters is byte-for-byte unchanged apart from the new header.

## Non-goals

Filtering, sorting options, total counts.
