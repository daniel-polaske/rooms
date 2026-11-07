# Soft-delete a message

Operators need to remove a message's content without breaking the room's invariants.
`seq` is the room's total order (I1) and clients resync by `seq`, so rows are never removed:
the body is blanked and the row is marked.

## Requirements

- `DELETE /api/rooms/:name/messages/:seq`, guarded by the shared secret
  (`x-chaos-token`, exactly like `/archive`): `403` without it.
- On success: `200` with JSON `{ "seq": <seq>, "deleted": true }`. The row keeps its `seq`,
  `msg_id`, `author` and `ts`; `body` becomes `""` and a new column `deleted` becomes `1`.
  The schema change needs a migration that works for rooms created before it (see
  `DirectoryDO.migrate()` for the pattern).
- `history()` returns deleted rows in place, with `"deleted": true` on them and
  `"deleted": false` on the others.
- Every socket in the room receives `{ "type": "deleted", "seq": <seq> }`.
- Unknown `seq`: `404`. Deleting twice: `200` again, no second broadcast.
- Archives export rows as they are (blank body, `deleted: true`).

## Non-goals

Hard deletion, author self-deletion, audit log.
