# Per-author statistics for a room

Add a read-only endpoint that summarises who has posted in a room.

## Requirements

- `GET /api/rooms/:name/authors` returns a JSON array of
  `{ "author": string, "messages": number, "last_seq": number }`, one entry per distinct
  author, ordered by `messages` descending, then `author` ascending.
- An empty room returns `[]`.
- Computed in SQLite with one aggregate query (`GROUP BY`), not by paging history in
  JavaScript.
- Exposed on the object as an RPC method like `history()` and `status()`; the Router only
  routes. Follow the Router's handler-table style.

## Non-goals

Time windows, per-author rate information, caching.
