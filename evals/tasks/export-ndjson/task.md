# Stream an archive as NDJSON

An archive body is one JSON object with a `messages` array. Consumers that process archives
line by line (`jq -c`, log shippers) want newline-delimited JSON instead.

## Requirements

- `GET /api/archives/:instanceId/body?format=ndjson` responds `200` with
  `content-type: application/x-ndjson` and one message object per line, in `seq` order,
  exactly the objects that appear in the JSON archive's `messages` array. No header line,
  no trailing commas; a trailing newline is fine.
- `format=json` or no `format` is unchanged (the stored object, streamed as today).
- Any other `format`: `400` with JSON `{ "error": "bad format" }`.
- The Router must not buffer the whole archive in memory to do this: transform the R2
  body as a stream (a `TransformStream` over the stored JSON is acceptable; so is reading
  the stored object in a bounded way). State the approach in a comment.
- The 409 (no output yet) and 404 (object missing) cases behave as they do today for
  every format.

## Non-goals

Changing what the Workflow writes to R2, gzip, pagination of the body.
