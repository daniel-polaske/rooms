/**
 * RoomDO: one Durable Object per chat room.
 *
 * This is the 2009 IRC-server demo redone on the primitive that makes it
 * scale: a single-threaded object that owns this room's messages (SQLite),
 * this room's WebSockets (hibernating), and this room's timer (alarm).
 *
 * Invariants this class is built to demonstrate (and that the drills test):
 *   I1  Total order: every client observes `seq` values as a prefix of the
 *       sequence in SQLite. (Single thread + input/output gates.)
 *   I2  No acknowledged write is lost across any reset of the object.
 *       (Synchronous SQL; the output gate holds the reply until durable.)
 *   I3  Idempotent post: the same msg_id inserted twice yields one row.
 *       (Required because callers retry; at-least-once + non-idempotent = dupes.)
 */

import { DurableObject } from "cloudflare:workers";
import { log, type Trace } from "./log";

export interface Message {
  seq: number;
  msg_id: string;
  author: string;
  body: string;
  ts: number;
}

export type ChaosMode = "throw" | "abort" | "cpu" | "hang";

const IDLE_MS = 24 * 60 * 60 * 1000; // room idle -> archive

export class RoomDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  /** Changes on every construction. Two values in one minute = the object reset. */
  readonly incarnation: string = crypto.randomUUID().slice(0, 8);
  /** Cached only as a convenience; SQLite is the truth. */
  private name = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The input gate is closed until this resolves: no request can observe
    // a half-initialised object.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq    INTEGER PRIMARY KEY AUTOINCREMENT,
          msg_id TEXT    NOT NULL UNIQUE,
          author TEXT    NOT NULL,
          body   TEXT    NOT NULL,
          ts     INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      `);
      const row = this.sql.exec(`SELECT v FROM meta WHERE k = 'name'`).toArray()[0];
      this.name = (row?.v as string) ?? "";
    });
    this.log("room.start", { reason: "constructor" });
  }

  // ---------------------------------------------------------------- RPC API

  /** Called once by the Router so logs can show a human name, not just the id. */
  setName(name: string): void {
    if (this.name === name) return;
    this.name = name;
    this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('name', ?)`, name);
  }

  /**
   * Post a message. Returns the seq, or the existing seq if msg_id was seen
   * before (I3). Everything here is synchronous: no await between the
   * INSERT and the return, so there is no window in which another request
   * can interleave (I1) or a reset can lose an acknowledged write (I2).
   */
  post(msgId: string, author: string, body: string, trace?: Trace): { seq: number; duplicate: boolean } {
    const now = Date.now();
    const inserted = this.sql
      .exec(
        `INSERT OR IGNORE INTO messages (msg_id, author, body, ts) VALUES (?, ?, ?, ?) RETURNING seq`,
        msgId, author, body, now,
      )
      .toArray();

    let seq: number;
    let duplicate = false;
    if (inserted.length) {
      seq = inserted[0].seq as number;
    } else {
      duplicate = true;
      seq = this.sql.exec(`SELECT seq FROM messages WHERE msg_id = ?`, msgId).one().seq as number;
    }

    this.log(duplicate ? "room.post.duplicate" : "room.post", { seq, msg_id: msgId, author, ...trace });

    if (!duplicate) {
      // Fan-out inside the same synchronous block, so it either all happens
      // or the client never got an ack.
      this.broadcast({ type: "message", seq, msg_id: msgId, author, body, ts: now });
      // Every alarm set is a billed row write on the Free plan: one per post is fine.
      void this.ctx.storage.setAlarm(now + IDLE_MS);
      // At-least-once hop. The consumer must treat (room, msg_id) as idempotent.
      this.ctx.waitUntil(
        this.env.ROOM_EVENTS.send({ type: "posted", room: this.name, seq, msg_id: msgId, trace }),
      );
    }
    return { seq, duplicate };
  }

  /** Messages after `afterSeq`, oldest first. Clients use this to fill gaps after a reconnect. */
  history(afterSeq = 0, limit = 50): Message[] {
    limit = Math.min(Math.max(1, limit), 500); // rows-read quota is the one you hit first
    return this.sql
      .exec(`SELECT seq, msg_id, author, body, ts FROM messages WHERE seq > ? ORDER BY seq LIMIT ?`, afterSeq, limit)
      .toArray() as unknown as Message[];
  }

  /** Object-level facts for the troubleshooting playbook. Cheap: 2 rows read. */
  status() {
    const count = this.sql.exec(`SELECT COUNT(*) AS n, MAX(seq) AS max_seq FROM messages`).one();
    return {
      name: this.name,
      id: this.ctx.id.toString(),
      incarnation: this.incarnation,
      messages: count.n as number,
      max_seq: (count.max_seq as number | null) ?? 0,
      sockets: this.ctx.getWebSockets().length,
      db_bytes: this.sql.databaseSize,
    };
  }

  /**
   * Fault injection. Each mode is a different *kind* of failure:
   *   throw - an ordinary exception: the request fails, the object lives on.
   *   abort - ctx.abort(): the runtime discards the object. In-memory state,
   *           pending work and sockets are gone; SQLite is not. Next request
   *           constructs a new incarnation.
   *   cpu   - spin past the CPU limit (10 ms on Free): error 1102 / exceededCpu.
   *   hang  - await forever: the wedged object. Looks like silence from outside.
   */
  async chaos(mode: ChaosMode): Promise<never> {
    this.log("room.chaos", { mode });
    switch (mode) {
      case "throw":
        throw new Error("chaos: injected throw");
      case "abort":
        this.ctx.abort("chaos: injected abort");
        break;
      case "cpu": {
        // eslint-disable-next-line no-constant-condition
        let x = 0;
        while (true) x = (x + 1) | 0;
      }
      case "hang":
        await new Promise(() => {});
        break;
    }
    throw new Error("unreachable");
  }

  // ----------------------------------------------------------- WebSockets

  /** HTTP entry: only used for the WebSocket upgrade. Everything else is RPC. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation API: the runtime holds the socket while this object is
    // evicted from memory, and wakes us for messages. Tag = author (optional).
    const author = new URL(request.url).searchParams.get("author") ?? "anon";
    this.ctx.acceptWebSocket(server, [author]);
    this.log("room.ws.open", { author, sockets: this.ctx.getWebSockets().length });
    server.send(JSON.stringify({ type: "hello", incarnation: this.incarnation, max_seq: this.status().max_seq }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: { type: string; msg_id?: string; body?: string; after?: number };
    try { msg = JSON.parse(raw); } catch { return; }
    const author = this.ctx.getTags(ws)[0] ?? "anon";

    if (msg.type === "post" && msg.msg_id && msg.body) {
      const r = this.post(msg.msg_id, author, msg.body);
      ws.send(JSON.stringify({ type: "ack", msg_id: msg.msg_id, seq: r.seq, duplicate: r.duplicate }));
    } else if (msg.type === "sync") {
      ws.send(JSON.stringify({ type: "history", messages: this.history(msg.after ?? 0, 500) }));
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", incarnation: this.incarnation }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.log("room.ws.close", { code, reason, sockets: this.ctx.getWebSockets().length - 1 });
    ws.close(code, reason);
  }

  async webSocketError(_ws: WebSocket, err: unknown): Promise<void> {
    this.log("room.ws.error", { error: String(err) });
  }

  private broadcast(payload: unknown): void {
    const s = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch { /* closed; the close handler will log it */ }
    }
  }

  // ---------------------------------------------------------------- Alarm

  /** Fires IDLE_MS after the last post. Starts the archive Workflow. */
  async alarm(): Promise<void> {
    const st = this.status();
    this.log("room.idle", { messages: st.messages, sockets: st.sockets });
    if (st.messages === 0) return;
    await this.env.ARCHIVE.create({ id: `archive-${this.name}-${Date.now()}`, params: { room: this.name } });
  }

  // ------------------------------------------------------------- Logging

  private log(event: string, fields: Record<string, unknown> = {}): void {
    log(event, { do: "RoomDO", name: this.name, id: this.ctx.id.toString(), incarnation: this.incarnation, ...fields });
  }
}
