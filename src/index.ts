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
 *   POST /api/rooms/:name/archive           start the archive Workflow now (X-Chaos-Token)
 *   GET  /api/archives/:instanceId          Workflow status + output
 *   GET  /api/archives/:instanceId/body     the archived JSON from R2
 *   GET  /api/directory                     directory status
 */

import { childSpan, log, newTrace, traceparent, type Trace } from "./log";
import { AccessError, verifyAccess, type Caller } from "./access";
import type { ChaosMode } from "./room";

export { RoomDO } from "./room";
export { DirectoryDO } from "./directory";
export { ArchiveWorkflow } from "./archive";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const ROOM_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** What the Router reports about a failure. Objects mark resets as retryable; everything else is not. */
function describe(e: unknown): { message: string; retryable: boolean } {
  const err = e as { message?: unknown; retryable?: unknown } | null;
  return { message: String(err?.message ?? e), retryable: !!err?.retryable };
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const trace = newTrace(request.headers.get("traceparent"));
    const started = Date.now();
    const colo = (request.cf as { colo?: string } | undefined)?.colo ?? "local";
    const base: Record<string, unknown> = { trace_id: trace.trace_id, span_id: trace.span_id, method: request.method, path: url.pathname, colo };

    try {
      // Access verified the request at the edge; we verify its proof and learn who is calling.
      let caller: Caller | null = null;
      try {
        caller = await verifyAccess(request, env);
      } catch (e) {
        if (e instanceof AccessError) {
          log("http.denied", { ...base, reason: e.message });
          return json({ error: "unauthorized", reason: e.message, trace_id: trace.trace_id }, 401);
        }
        throw e;
      }
      if (caller) { base.caller = caller.id; base.caller_kind = caller.kind; }

      const res = await route(request, env, url, trace, caller);
      log("http.done", { ...base, status: res.status, wall_ms: Date.now() - started });
      // A 101 must be returned exactly as the object produced it: its headers
      // are immutable once it has crossed the isolate boundary, and the
      // WebSocket is attached to that specific Response object.
      if (res.status === 101) return res;
      const out = new Response(res.body, res);
      out.headers.set("traceparent", traceparent(trace));
      return out;
    } catch (e) {
      const { message, retryable } = describe(e);
      log("http.error", { ...base, error: message, retryable, wall_ms: Date.now() - started });
      return json({ error: message, retryable, trace_id: trace.trace_id }, 500);
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
    for (const m of batch.messages) if ((m.body as { msg_id?: string }).msg_id !== "poison") m.ack();
  },
} satisfies ExportedHandler<Env>;

/** Everything a handler needs to know about the request, resolved once in fetch(). */
interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  trace: Trace;
  caller: Caller | null;
}
type RoomStub = ReturnType<Env["ROOM"]["getByName"]>;

async function route(request: Request, env: Env, url: URL, trace: Trace, caller: Caller | null): Promise<Response> {
  const ctx: RouteContext = { request, env, url, trace, caller };
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "rooms", name, sub]

  if (parts[1] === "directory" && request.method === "GET") {
    return json(await env.DIRECTORY.getByName("main").status());
  }
  if (parts[1] === "archives" && parts[2] && request.method === "GET") {
    return archiveStatus(env, parts[2], parts[3] === "body");
  }
  if (parts[1] !== "rooms") return json({ error: "not found" }, 404);
  if (parts.length === 2 && request.method === "GET") {
    return json(await env.DIRECTORY.getByName("main").list());
  }

  const name = parts[2];
  if (!name || !ROOM_NAME.test(name)) return json({ error: "bad room name" }, 400);
  return routeRoom(ctx, name, parts[3]);
}

async function archiveStatus(env: Env, instanceId: string, wantBody: boolean): Promise<Response> {
  const inst = await env.ARCHIVE.get(instanceId).catch(() => null);
  if (!inst) return json({ error: "no such instance" }, 404);
  const st = await inst.status();
  if (!wantBody) return json({ id: instanceId, ...st });
  const key = (st.output as { key?: string } | undefined)?.key;
  if (!key) return json({ status: st.status, error: "no output yet" }, 409);
  const obj = await env.ARCHIVES.get(key);
  if (!obj) return json({ error: "object missing", key }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/json", etag: obj.etag } });
}

async function routeRoom(ctx: RouteContext, name: string, sub: string | undefined): Promise<Response> {
  const { request, env, url } = ctx;
  // idFromName is deterministic: the same name always maps to the same object,
  // wherever in the world it currently lives. That one line is the sharding.
  const room = env.ROOM.getByName(name);

  const handlers: Record<string, () => Promise<Response>> = {
    "GET": async () => { await room.setName(name); return json(await room.status()); },
    "ws": () => openSocket(ctx, room, name), // any method: the object answers 426 to a non-upgrade
    "GET messages": async () => {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(await room.history(after, limit));
    },
    "POST messages": () => postMessage(ctx, room, name),
    "POST archive": async () => requireToken(ctx) ?? startArchive(room, name),
    "POST chaos": async () => requireToken(ctx) ?? injectChaos(ctx, room, name),
  };
  const key = sub === "ws" ? "ws" : [request.method, sub].filter(Boolean).join(" ");
  const handler = handlers[key];
  return handler ? handler() : json({ error: "not found" }, 404);
}

async function openSocket(ctx: RouteContext, room: RoomStub, name: string): Promise<Response> {
  let { request } = ctx;
  await room.setName(name);
  // The object tags the socket with ?author=; a verified user identity wins over the client's claim.
  if (ctx.caller?.kind === "user") {
    const u = new URL(request.url); u.searchParams.set("author", ctx.caller.id);
    request = new Request(u, request);
  }
  return room.fetch(request); // upgrade is handled inside the object
}

async function postMessage(ctx: RouteContext, room: RoomStub, name: string): Promise<Response> {
  const { request, caller, trace } = ctx;
  const body = (await request.json().catch(() => null)) as { msg_id?: string; author?: string; body?: string } | null;
  if (!body?.body) return json({ error: "body required" }, 400);
  const msgId = body.msg_id ?? crypto.randomUUID();
  // A verified person is the author, whatever the body says; a service token keeps the body's author.
  const author = caller?.kind === "user" ? caller.id : (body.author ?? "anon");
  await room.setName(name);
  // Retry only errors the runtime marks retryable (object reset, etc.).
  // Safe because post() is idempotent on msg_id. Remove the idempotency and
  // this wrapper will double-post: that is the Stage 2 lesson.
  const r = await withRetry(() => room.post(msgId, author, body.body!, childSpan(trace)));
  return json({ ...r, msg_id: msgId }, r.duplicate ? 200 : 201);
}

/** The fault-injection and archive endpoints share one secret. Returns the 403, or null to proceed. */
function requireToken({ request, env }: RouteContext): Response | null {
  const token = request.headers.get("x-chaos-token");
  if (!env.CHAOS_TOKEN || token !== env.CHAOS_TOKEN) return json({ error: "forbidden" }, 403);
  return null;
}

async function startArchive(room: RoomStub, name: string): Promise<Response> {
  await room.setName(name);
  const id = await room.startArchive("manual");
  return json({ instance: id, status_url: `/api/archives/${id}` }, 202);
}

async function injectChaos(ctx: RouteContext, room: RoomStub, name: string): Promise<Response> {
  const mode = (ctx.url.searchParams.get("mode") ?? "throw") as ChaosMode;
  if (!["throw", "abort", "cpu", "hang"].includes(mode)) return json({ error: "bad mode" }, 400);
  log("chaos.request", { room: name, mode, trace_id: ctx.trace.trace_id });
  await room.setName(name);
  // No retry here, on purpose: we want to see the raw failure.
  await room.chaos(mode);
  return json({ ok: true }); // only "hang" would never get here; others throw
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const { message, retryable } = describe(e);
      if (!retryable) throw e;
      log("router.retry", { attempt: i + 1, error: message });
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw last;
}
