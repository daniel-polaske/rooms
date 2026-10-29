/**
 * DirectoryDO: a deliberate singleton.
 *
 * One object (named "main") indexes every room and keeps per-room counters.
 * It receives its updates from the Queue consumer, not from rooms directly,
 * so a burst of posts across many rooms becomes a steady stream of batches.
 *
 * Stage 5's "hot singleton" drill overloads this object on purpose. The fix
 * you will reach for (shard by hash(room) % N) is the lesson.
 */

import { DurableObject } from "cloudflare:workers";
import { log } from "./log";

export class DirectoryDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  readonly incarnation: string = crypto.randomUUID().slice(0, 8);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          name      TEXT PRIMARY KEY,
          messages  INTEGER NOT NULL DEFAULT 0,
          last_seq  INTEGER NOT NULL DEFAULT 0,
          last_ts   INTEGER NOT NULL DEFAULT 0,
          archived  INTEGER NOT NULL DEFAULT 0,
          archive_key TEXT
        );
        -- Idempotency ledger for queue messages: (room, msg_id) seen once.
        -- Kept small by pruning in bump().
        CREATE TABLE IF NOT EXISTS seen (room TEXT, msg_id TEXT, ts INTEGER, PRIMARY KEY (room, msg_id));
      `);
      this.migrate();
    });
    log("dir.start", { do: "DirectoryDO", incarnation: this.incarnation });
  }

  /**
   * Schema migrations for objects that already exist. There is no central
   * database to migrate: every object carries its own SQLite file and
   * upgrades itself the first time new code constructs it. PRAGMA user_version
   * is the per-object schema version. Each step must be idempotent.
   */
  private migrate(): void {
    // Not PRAGMA user_version: DO SQLite allows only a whitelist of PRAGMAs
    // (writing user_version fails with SQLITE_AUTH). A one-row table does the job.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL)`);
    const row = this.sql.exec(`SELECT version FROM schema`).toArray()[0];
    const v = (row?.version as number | undefined) ?? 0;
    if (v < 1) {
      const cols = this.sql.exec(`PRAGMA table_info(rooms)`).toArray().map((c) => c.name);
      if (!cols.includes("archive_key")) this.sql.exec(`ALTER TABLE rooms ADD COLUMN archive_key TEXT`);
      this.sql.exec(`DELETE FROM schema; INSERT INTO schema (version) VALUES (1)`);
      log("dir.migrate", { do: "DirectoryDO", from: v, to: 1 });
    }
  }

  /**
   * Apply a batch of "posted" events. Idempotent per (room, msg_id), because
   * the Queue is at-least-once and *will* redeliver after a consumer crash.
   */
  bump(events: { room: string; seq: number; msg_id: string }[]): { applied: number; skipped: number } {
    let applied = 0, skipped = 0;
    const now = Date.now();
    for (const e of events) {
      const ins = this.sql
        .exec(`INSERT OR IGNORE INTO seen (room, msg_id, ts) VALUES (?, ?, ?)`, e.room, e.msg_id, now)
        .rowsWritten;
      if (ins === 0) { skipped++; continue; }
      this.sql.exec(
        `INSERT INTO rooms (name, messages, last_seq, last_ts) VALUES (?, 1, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           messages = messages + 1,
           last_seq = MAX(last_seq, excluded.last_seq),
           last_ts  = excluded.last_ts,
           archived = 0`,
        e.room, e.seq, now,
      );
      applied++;
    }
    // Prune the ledger: anything older than a day cannot be redelivered (Free retention = 24 h).
    this.sql.exec(`DELETE FROM seen WHERE ts < ?`, now - 24 * 3600 * 1000);
    log("dir.bump", { do: "DirectoryDO", incarnation: this.incarnation, applied, skipped });
    return { applied, skipped };
  }

  list(limit = 100) {
    return this.sql
      .exec(`SELECT name, messages, last_seq, last_ts, archived, archive_key FROM rooms ORDER BY last_ts DESC LIMIT ?`, Math.min(limit, 500))
      .toArray();
  }

  archive(room: string, key?: string): void {
    this.sql.exec(
      `INSERT INTO rooms (name, archived, archive_key) VALUES (?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET archived = 1, archive_key = excluded.archive_key`,
      room, key ?? null,
    );
    log("dir.archive", { do: "DirectoryDO", room, key });
  }

  status() {
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM rooms`).one().n as number;
    return { id: this.ctx.id.toString(), incarnation: this.incarnation, rooms: n, db_bytes: this.sql.databaseSize };
  }
}
