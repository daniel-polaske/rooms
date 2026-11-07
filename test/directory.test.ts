/**
 * DirectoryDO: the deliberate singleton. What matters is idempotency under
 * at-least-once delivery, and that a room which wakes up is un-archived.
 */
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DirectoryDO } from "../src/directory";

const dir = () => env.DIRECTORY.getByName("main");

describe("DirectoryDO", () => {
  it("bump() is idempotent per (room, msg_id)", async () => {
    const d = dir();
    const first = await d.bump([
      { room: "a", seq: 1, msg_id: "m1" },
      { room: "a", seq: 2, msg_id: "m2" },
    ]);
    expect(first).toEqual({ applied: 2, skipped: 0 });
    // The Queue redelivers after a consumer crash: the same batch again.
    const again = await d.bump([
      { room: "a", seq: 1, msg_id: "m1" },
      { room: "a", seq: 2, msg_id: "m2" },
      { room: "a", seq: 3, msg_id: "m3" },
    ]);
    expect(again).toEqual({ applied: 1, skipped: 2 });
    const [row] = await d.list();
    expect(row).toMatchObject({ name: "a", messages: 3, last_seq: 3, archived: 0 });
  });

  it("last_seq never goes backwards when batches arrive out of order", async () => {
    const d = dir();
    await d.bump([{ room: "b", seq: 9, msg_id: "late-9" }]);
    await d.bump([{ room: "b", seq: 4, msg_id: "late-4" }]);
    const row = (await d.list()).find((r) => r.name === "b");
    expect(row).toMatchObject({ messages: 2, last_seq: 9 });
  });

  it("archive() marks a room and bump() un-archives it when it wakes up", async () => {
    const d = dir();
    await d.bump([{ room: "c", seq: 1, msg_id: "c1" }]);
    await d.archive("c", "rooms/c/archive-c-1-idle.json");
    expect((await d.list()).find((r) => r.name === "c")).toMatchObject({ archived: 1, archive_key: "rooms/c/archive-c-1-idle.json" });
    await d.bump([{ room: "c", seq: 2, msg_id: "c2" }]);
    expect((await d.list()).find((r) => r.name === "c")).toMatchObject({ archived: 0, messages: 2 });
  });

  it("archive() of a room the directory has never seen creates its row", async () => {
    const d = dir();
    await d.archive("ghost");
    expect((await d.list()).find((r) => r.name === "ghost")).toMatchObject({ archived: 1, archive_key: null, messages: 0 });
  });

  it("list() orders by last activity and clamps limit to 500", async () => {
    const d = dir();
    const events = Array.from({ length: 501 }, (_, i) => ({ room: `r${i}`, seq: 1, msg_id: `r${i}-1` }));
    await d.bump(events);
    expect(await d.list(10_000)).toHaveLength(500);
    expect(await d.list(2)).toHaveLength(2);
    await d.bump([{ room: "r0", seq: 2, msg_id: "r0-2" }]); // newest activity goes first
    expect((await d.list(1))[0].name).toBe("r0");
  });

  it("status() counts rooms and reports the incarnation", async () => {
    const d = dir();
    await d.bump([{ room: "s", seq: 1, msg_id: "s1" }]);
    const st = await d.status();
    expect(st.rooms).toBeGreaterThanOrEqual(1);
    expect(st.incarnation).toMatch(/^[0-9a-f]{8}$/);
    expect(st.db_bytes).toBeGreaterThan(0);
  });

  it("the schema migration is idempotent across resets", async () => {
    const d = dir();
    await d.bump([{ room: "m", seq: 1, msg_id: "m1" }]);
    const version = () =>
      runInDurableObject(d, (_i: DirectoryDO, state) => state.storage.sql.exec(`SELECT version FROM schema`).one().version);
    expect(await version()).toBe(1);
    await evictDurableObject(d); // new code constructs the object again: migrate() re-runs
    expect(await version()).toBe(1);
    expect((await dir().list()).find((r) => r.name === "m")).toMatchObject({ messages: 1 });
  });
});
