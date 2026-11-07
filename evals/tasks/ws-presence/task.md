# Presence over the socket

Clients cannot tell who else is in a room. Announce joins and leaves to everyone connected.

## Requirements

- When a WebSocket is accepted, every socket in the room (including the new one) receives
  `{ "type": "presence", "event": "join", "author": <tag>, "sockets": <count after> }`,
  after the new socket's `hello`.
- When a socket closes (`webSocketClose`) or errors, every remaining socket receives
  `{ "type": "presence", "event": "leave", "author": <tag>, "sockets": <count after> }`.
- `sockets` is the live count from the hibernation API, so it is correct across evictions.
  Fix the off-by-one in the existing `room.ws.close` log line while you are there
  (`getWebSockets()` may or may not still include the closing socket; count what is left).
- `hello`, `ack`, `message`, `history`, `pong` are unchanged. `status()` is unchanged.

## Non-goals

A presence list endpoint, deduplicating multiple sockets per author, typing indicators.
