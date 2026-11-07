# Limit message size

Rooms accept any body today. Add a size limit so one client cannot fill a room's SQLite
file or blow the rows-read budget of every reader.

## Requirements

- A message body longer than **4096 bytes** (UTF-8 encoded length, not characters) is
  rejected. Exactly 4096 bytes is accepted.
- Over HTTP (`POST /api/rooms/:name/messages`): respond `413` with JSON
  `{ "error": "body too large", "max": 4096 }`. Nothing is stored, nothing is broadcast,
  no queue event is sent.
- Over the WebSocket (`{"type":"post", ...}`): reply to that socket only with
  `{ "type": "error", "msg_id": <the msg_id>, "reason": "body too large" }`. Nothing is
  stored or broadcast.
- The limit is one named constant, enforced in one place that both paths go through.
- Document it in the README's "Free plan notes" (one line).

## Non-goals

Truncation, compression, or per-room configuration.
