/**
 * Router Worker: the stateless "JavaScript container".
 *
 * Holds no state. Speaks only web-standard APIs. Could run on workerd,
 * celld or Cloudflare unchanged. Its jobs: parse the URL, pick the room id,
 * mint a trace, call the object, retry what is safe to retry.
 *
 * Routes
 *   GET  /api/rooms                         list rooms (DirectoryDO)
 *   GET  /api/rooms/:name                   room status
 *   GET  /api/rooms/:name/messages?after=N  history
 *   POST /api/rooms/:name/messages          {msg_id?, author, body}
 *   GET  /api/rooms/:name/ws?author=X       WebSocket
 *   POST /api/rooms/:name/chaos?mode=M      fault injection (X-Chaos-Token)
 *   GET  /api/directory                     directory status
 */

import { childSpan, log, newTrace, traceparent } from "./log";
import type { ChaosMode } from "./room";

export { RoomDO } from "./room";
export { DirectoryDO } from "./directory";
export { ArchiveWorkflow } from "./archive";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const ROOM_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const trace = newTrace(request.headers.get("traceparent"));
    const started = Date.now();
    const colo = (request.cf as { colo?: string } | undefined)?.colo ?? "local";
    const base = { trace_id: trace.trace_id, span_id: trace.span_id, method: request.method, path: url.pathname, colo };

    try {
      const res = await route(request, env, url, trace);
      log("http.done", { ...base, status: res.status, wall_ms: Date.now() - started });
      // A 101 must be returned exactly as the object produced it: its headers
      // are immutable once it has crossed the isolate boundary, and the
      // WebSocket is attached to that specific Response object.
      if (res.status === 101) return res;
      const out = new Response(res.body, res);
      out.headers.set("traceparent", traceparent(trace));
      return out;
    } catch (e: any) {
      log("http.error", { ...base, error: String(e?.message ?? e), retryable: !!e?.retryable, wall_ms: Date.now() - started });
      return json({ error: String(e?.message ?? e), retryable: !!e?.retryable, trace_id: trace.trace_id }, 500);
    }
  },

  /**
   * Queue consumer. Stateless; forwards batches to DirectoryDO.bump(), which
   * is idempotent per (room, msg_id). ack/retry per message, never per batch,
   * so one poison message cannot block the rest.
   */
  async queue(batch, env): Promise<void> {
    const events: { room: string; seq: number; msg_id: string }[] = [];
    for (const m of batch.messages) {
      const b = m.body as { type: string; room: string; seq: number; msg_id: string; trace?: { trace_id: string } };
      if (b.msg_id === "poison") {
        // Stage 5 drill: a message the consumer can never process.
        log("queue.poison", { msg_id: b.msg_id, attempts: m.attempts, trace_id: b.trace?.trace_id });
        m.retry();
        continue;
      }
      if (m.attempts > 1) log("queue.retry", { room: b.room, msg_id: b.msg_id, attempts: m.attempts, trace_id: b.trace?.trace_id });
      events.push({ room: b.room, seq: b.seq, msg_id: b.msg_id });
    }
    if (events.length) {
      const r = await env.DIRECTORY.getByName("main").bump(events);
      log("queue.batch", { size: batch.messages.length, ...r });
    }
    // Ack only what we handed off; poison messages were already marked retry().
    for (const m of batch.messages) if ((m.body as any).msg_id !== "poison") m.ack();
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL, trace: ReturnType<typeof newTrace>): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "rooms", name, sub]

  if (parts[1] === "directory" && request.method === "GET") {
    return json(await env.DIRECTORY.getByName("main").status());
  }

  if (parts[1] !== "rooms") return json({ error: "not found" }, 404);

  if (parts.length === 2 && request.method === "GET") {
    return json(await env.DIRECTORY.getByName("main").list());
  }

  const name = parts[2];
  if (!name || !ROOM_NAME.test(name)) return json({ error: "bad room name" }, 400);
  const sub = parts[3];

  // idFromName is deterministic: the same name always maps to the same object,
  // wherever in the world it currently lives. That one line is the sharding.
  const room = env.ROOM.getByName(name);

  if (!sub && request.method === "GET") {
    await room.setName(name);
    return json(await room.status());
  }

  if (sub === "ws") {
    await room.setName(name);
    return room.fetch(request); // upgrade is handled inside the object
  }

  if (sub === "messages" && request.method === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return json(await room.history(after, limit));
  }

  if (sub === "messages" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { msg_id?: string; author?: string; body?: string } | null;
    if (!body?.body) return json({ error: "body required" }, 400);
    const msgId = body.msg_id ?? crypto.randomUUID();
    await room.setName(name);
    // Retry only errors the runtime marks retryable (object reset, etc.).
    // Safe because post() is idempotent on msg_id. Remove the idempotency and
    // this wrapper will double-post: that is the Stage 2 lesson.
    const r = await withRetry(() => room.post(msgId, body.author ?? "anon", body.body!, childSpan(trace)));
    return json({ ...r, msg_id: msgId }, r.duplicate ? 200 : 201);
  }

  if (sub === "chaos" && request.method === "POST") {
    const token = request.headers.get("x-chaos-token");
    if (!env.CHAOS_TOKEN || token !== env.CHAOS_TOKEN) return json({ error: "forbidden" }, 403);
    const mode = (url.searchParams.get("mode") ?? "throw") as ChaosMode;
    if (!["throw", "abort", "cpu", "hang"].includes(mode)) return json({ error: "bad mode" }, 400);
    log("chaos.request", { room: name, mode, trace_id: trace.trace_id });
    await room.setName(name);
    // No retry here, on purpose: we want to see the raw failure.
    await room.chaos(mode);
    return json({ ok: true }); // only "hang" would never get here; others throw
  }

  return json({ error: "not found" }, 404);
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      if (!e?.retryable) throw e;
      log("router.retry", { attempt: i + 1, error: String(e?.message ?? e) });
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw last;
}
