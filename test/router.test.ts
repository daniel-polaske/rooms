/**
 * The Router Worker: routing, validation, the retry wrapper, the Queue consumer.
 * Exercised through the exported handler with the real bindings underneath.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

type IncomingRequest = Parameters<typeof worker.fetch>[0];
const call = async (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://rooms.test${path}`, init) as unknown as IncomingRequest, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};
type WsEvent = { type: string; [k: string]: unknown };
const next = (ws: WebSocket) =>
  new Promise<WsEvent>((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true }));
const open = async (room: string, author?: string) => {
  const res = await call(`/api/rooms/${room}/ws${author ? `?author=${author}` : ""}`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const hello = await next(ws);
  expect(hello.type).toBe("hello");
  return ws;
};
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const TOKEN = { "x-chaos-token": "test-token" };

describe("Router", () => {
  it("serves the static client for non-API paths", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html");
  });

  it("rejects a bad room name before touching any object", async () => {
    expect((await call("/api/rooms/Not%20Valid")).status).toBe(400);
    expect((await call("/api/rooms/-leading-dash")).status).toBe(400);
    expect((await call(`/api/rooms/${"x".repeat(65)}`)).status).toBe(400);
  });

  it("404s unknown routes", async () => {
    expect((await call("/api/nope")).status).toBe(404);
    expect((await call("/api/rooms/lobby/nothing")).status).toBe(404);
    expect((await call("/api/archives/does-not-exist")).status).toBe(404);
  });

  it("posts a message (201), treats a replay as a duplicate (200), and reads it back", async () => {
    const first = await call("/api/rooms/lobby/messages", json({ msg_id: "r-1", author: "dan", body: "hi" }));
    expect(first.status).toBe(201);
    const a = (await first.json()) as { seq: number; msg_id: string; duplicate: boolean };
    expect(a).toMatchObject({ msg_id: "r-1", duplicate: false });

    const replay = await call("/api/rooms/lobby/messages", json({ msg_id: "r-1", author: "dan", body: "hi" }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ seq: a.seq, duplicate: true });

    const hist = await call("/api/rooms/lobby/messages?after=0&limit=10");
    expect(await hist.json()).toMatchObject([{ msg_id: "r-1", author: "dan", body: "hi" }]);

    const status = await call("/api/rooms/lobby");
    expect(await status.json()).toMatchObject({ name: "lobby", messages: 1 });
  });

  it("mints a msg_id when the client sends none, and defaults the author", async () => {
    const res = await call("/api/rooms/anon/messages", json({ body: "no id" }));
    expect(res.status).toBe(201);
    const { msg_id } = (await res.json()) as { msg_id: string };
    expect(msg_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await (await call("/api/rooms/anon/messages")).json()).toMatchObject([{ author: "anon" }]);
  });

  it("requires a body on POST and tolerates malformed JSON", async () => {
    expect((await call("/api/rooms/lobby/messages", json({ author: "dan" }))).status).toBe(400);
    expect((await call("/api/rooms/lobby/messages", { method: "POST", body: "{not json" })).status).toBe(400);
  });

  it("guards chaos and archive behind the token", async () => {
    expect((await call("/api/rooms/lobby/chaos?mode=throw", { method: "POST" })).status).toBe(403);
    expect((await call("/api/rooms/lobby/chaos?mode=throw", { method: "POST", headers: { "x-chaos-token": "wrong" } })).status).toBe(403);
    expect((await call("/api/rooms/lobby/archive", { method: "POST" })).status).toBe(403);
    expect((await call("/api/rooms/lobby/chaos?mode=bogus", { method: "POST", headers: TOKEN })).status).toBe(400);
  });

  it("chaos=throw surfaces as a 500 with the trace id; the room keeps its incarnation", async () => {
    const before = ((await (await call("/api/rooms/throwy")).json()) as { incarnation: string }).incarnation;
    const res = await call("/api/rooms/throwy/chaos?mode=throw", { method: "POST", headers: TOKEN });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; retryable: boolean; trace_id: string };
    expect(body.error).toMatch(/injected throw/);
    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(((await (await call("/api/rooms/throwy")).json()) as { incarnation: string }).incarnation).toBe(before);
  });

  it("archive starts a Workflow (202) and its status is readable", async () => {
    await call("/api/rooms/arch/messages", json({ msg_id: "a1", body: "x" }));
    const res = await call("/api/rooms/arch/archive", { method: "POST", headers: TOKEN });
    expect(res.status).toBe(202);
    const { instance, status_url } = (await res.json()) as { instance: string; status_url: string };
    expect(instance).toMatch(/^archive-arch-\d+-manual$/);
    const st = await call(status_url);
    expect(st.status).toBe(200);
    expect(await st.json()).toMatchObject({ id: instance });
    // No output yet: the body endpoint says so instead of 404ing the bucket.
    expect((await call(`${status_url}/body`)).status).toBe(409);
  });

  it("propagates an incoming traceparent and mints one otherwise", async () => {
    const given = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const res = await call("/api/directory", { headers: { traceparent: given } });
    expect(res.headers.get("traceparent")).toMatch(/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
    const fresh = await call("/api/directory");
    expect(fresh.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("lists rooms via the directory once the queue consumer has run", async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch("room-events", [
      { id: "1", timestamp: Date.now(), attempts: 1, body: { type: "posted", room: "q", seq: 1, msg_id: "q-1" } },
      { id: "2", timestamp: Date.now(), attempts: 2, body: { type: "posted", room: "q", seq: 2, msg_id: "q-2" } },
      { id: "3", timestamp: Date.now(), attempts: 1, body: { type: "posted", room: "q", seq: 3, msg_id: "poison" } },
    ]);
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["1", "2"]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["3"]); // the poison message never blocks the batch
    const rooms = (await (await call("/api/rooms")).json()) as { name: string; messages: number }[];
    expect(rooms.find((r) => r.name === "q")).toMatchObject({ messages: 2, last_seq: 2 });
  });

  it("refuses a non-upgrade request to the socket endpoint", async () => {
    expect((await call("/api/rooms/ws-room/ws")).status).toBe(426);
  });
});

describe("WebSockets (hibernation API)", () => {
  it("says hello with the incarnation and counts the socket", async () => {
    const ws = await open("ws-hello", "dan");
    expect(await (await call("/api/rooms/ws-hello")).json()).toMatchObject({ sockets: 1 });
    ws.close(1000, "done");
  });

  it("post over the socket: the broadcast lands before the ack; a duplicate gets an ack and no broadcast", async () => {
    const ws = await open("ws-post", "dan");
    ws.send(JSON.stringify({ type: "post", msg_id: "w-1", body: "via ws" }));
    // Fan-out happens inside post(), so the sender sees its own message first, then the ack.
    expect(await next(ws)).toMatchObject({ type: "message", msg_id: "w-1", author: "dan", body: "via ws" });
    const ack = await next(ws);
    expect(ack).toMatchObject({ type: "ack", msg_id: "w-1", duplicate: false });
    ws.send(JSON.stringify({ type: "post", msg_id: "w-1", body: "via ws" }));
    expect(await next(ws)).toMatchObject({ type: "ack", msg_id: "w-1", seq: ack.seq, duplicate: true });
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await next(ws)).toMatchObject({ type: "pong" }); // nothing was broadcast for the duplicate
    expect(await (await call("/api/rooms/ws-post/messages")).json()).toMatchObject([{ msg_id: "w-1", author: "dan", body: "via ws" }]);
    ws.close(1000, "done");
  });

  it("sync returns history after a seq; ping returns pong; junk is ignored", async () => {
    const ws = await open("ws-sync");
    ws.send(JSON.stringify({ type: "post", msg_id: "s-1", body: "one" }));
    await next(ws); // broadcast
    const first = await next(ws); // ack
    ws.send(JSON.stringify({ type: "post", msg_id: "s-2", body: "two" }));
    await next(ws);
    await next(ws);
    ws.send(JSON.stringify({ type: "sync", after: first.seq }));
    const hist = await next(ws);
    expect(hist.type).toBe("history");
    expect((hist.messages as { msg_id: string; author: string }[]).map((m) => m.msg_id)).toEqual(["s-2"]);
    expect((hist.messages as { author: string }[])[0].author).toBe("anon"); // no ?author= tag
    ws.send("not json");
    ws.send(new Uint8Array([1, 2, 3]));
    ws.send(JSON.stringify({ type: "post", body: "no msg_id, ignored" }));
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await next(ws)).toMatchObject({ type: "pong" }); // ordering proves the junk produced nothing
    ws.close(1000, "done");
  });

  it("broadcasts a post made over HTTP to every socket in the room", async () => {
    const a = await open("ws-cast", "a");
    const b = await open("ws-cast", "b");
    const [ea, eb] = await Promise.all([next(a), next(b), call("/api/rooms/ws-cast/messages", json({ msg_id: "c-1", author: "http", body: "to all" }))]);
    expect(ea).toMatchObject({ type: "message", msg_id: "c-1", author: "http", body: "to all" });
    expect(eb).toMatchObject({ type: "message", msg_id: "c-1" });
    a.close(1000, "done");
    b.close(1000, "done");
  });
});
