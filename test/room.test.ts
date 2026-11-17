/**
 * RoomDO invariants, executed against a real SQLite-backed Durable Object.
 *
 *   I1  total order: seq strictly increasing, history is a prefix of SQLite
 *   I2  no acknowledged write is lost across a reset of the object
 *   I3  post() is idempotent on msg_id
 */
import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const room = (name: string) => {
  const stub = env.ROOM.getByName(name);
  return stub;
};

describe("RoomDO", () => {
  it("I3: posting the same msg_id twice yields one row and the same seq", async () => {
    const r = room("i3");
    await r.setName("i3");
    const first = await r.post("m-1", "dan", "hello");
    const second = await r.post("m-1", "dan", "hello again");
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);
    const hist = await r.history(0, 50);
    expect(hist).toHaveLength(1);
    expect(hist[0].body).toBe("hello"); // the first write wins; the retry changes nothing
  });

  it("I1: seq is strictly increasing and history is ordered", async () => {
    const r = room("i1");
    await r.setName("i1");
    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) seqs.push((await r.post(`m-${i}`, "dan", `msg ${i}`)).seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    const hist = await r.history(0, 500);
    expect(hist.map((m) => m.seq)).toEqual(seqs);
    expect(hist.map((m) => m.msg_id)).toEqual(seqs.map((_, i) => `m-${i}`));
  });

  it("history pages by `after` and clamps `limit` to [1, 500]", async () => {
    const r = room("paging");
    await r.setName("paging");
    for (let i = 0; i < 505; i++) await r.post(`p-${i}`, "dan", `msg ${i}`);
    const all = await r.history(0, 10_000);
    expect(all).toHaveLength(500); // rows-read quota: the cap is the point
    const one = await r.history(0, 0);
    expect(one).toHaveLength(1);
    const rest = await r.history(all[all.length - 1].seq, 500);
    expect(rest).toHaveLength(5);
    expect(rest[0].seq).toBeGreaterThan(all[all.length - 1].seq);
  });

  it("I2: an acknowledged write survives a reset; the incarnation changes", async () => {
    const r = room("i2");
    await r.setName("i2");
    const before = await r.status();
    const ack = await r.post("survivor", "dan", "still here");
    await evictDurableObject(r); // the runtime discards the instance; SQLite stays
    const r2 = room("i2");
    const after = await r2.status();
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(after.name).toBe("i2"); // name was persisted in `meta`, not just cached
    const hist = await r2.history(0, 50);
    expect(hist.map((m) => m.msg_id)).toEqual(["survivor"]);
    expect(hist[0].seq).toBe(ack.seq);
  });

  it("status() reports counts, max_seq and sockets", async () => {
    const r = room("status");
    await r.setName("status");
    expect(await r.status()).toMatchObject({ name: "status", messages: 0, max_seq: 0, sockets: 0 });
    const a = await r.post("s-1", "dan", "one");
    await r.post("s-2", "dan", "two");
    const st = await r.status();
    expect(st.messages).toBe(2);
    expect(st.max_seq).toBeGreaterThan(a.seq);
    expect(st.incarnation).toMatch(/^[0-9a-f]{8}$/);
  });

  it("describe(): identity comes from the platform, with no setName", async () => {
    const d = await room("desc-id").describe();
    expect(d.name).toBe("desc-id"); // ctx.id.name: the Router never had to tell it
    expect(d.stored_name).toBe(""); // nobody called setName
    expect(d.id).toBe(env.ROOM.idFromName("desc-id").toString());
    expect(d.id).toMatch(/^[0-9a-f]{64}$/);
    expect(d.jurisdiction).toBeNull();
    expect(d.incarnation).toMatch(/^[0-9a-f]{8}$/);
    expect(d.started_at).toBeGreaterThan(Date.now() - 60_000);
    expect(d.started_at).toBeLessThanOrEqual(Date.now());
  });

  it("describe(): an object reached only by its id string has no name to report", async () => {
    const anonymous = env.ROOM.get(env.ROOM.idFromString(env.ROOM.idFromName("desc-anon").toString()));
    const d = await anonymous.describe();
    expect(d.name).toBeNull();
    expect(d.id).toBe(env.ROOM.idFromName("desc-anon").toString());
  });

  it("describe(): what it holds, who is connected, what will wake it", async () => {
    const r = room("desc-holds");
    const empty = await r.describe();
    expect(empty).toMatchObject({ max_seq: 0, alarm_at: null, sockets: 0 });
    // The first call sees the two tables in creation order reversed; the answer is sorted anyway.
    expect(empty.tables).toEqual([...empty.tables].sort());
    expect(empty.tables).toEqual(expect.arrayContaining(["messages", "meta"]));
    expect(empty.tables.filter((t) => t.startsWith("sqlite_"))).toEqual([]);
    expect(typeof empty.bookmark).toBe("string");

    const before = Date.now();
    const { seq } = await r.post("d-1", "dan", "one");
    await r.post("d-2", "dan", "two");
    const d = await r.describe();
    expect(d.max_seq).toBe(seq + 1);
    expect(d.alarm_at).toBeGreaterThanOrEqual(before + 1000); // IDLE_MS in the test config
    expect(d.db_bytes).toBeGreaterThan(0);
    expect(d.db_bytes).toBe((await r.status()).db_bytes);
  });

  it("describe(): costs one row however long the history", async () => {
    const r = room("desc-cost");
    expect((await r.describe()).rows_read).toBe(1);
    for (let i = 0; i < 60; i++) await r.post(`c-${i}`, "dan", `msg ${i}`);
    const d = await r.describe();
    expect(d.max_seq).toBe(60);
    expect(d.rows_read).toBe(1); // status() reads all 60 for its COUNT(*)
  });

  it("describe(): a reset mints a new incarnation and start time; what it holds stays", async () => {
    const r = room("desc-reset");
    await r.setName("desc-reset");
    await r.post("keep", "dan", "durable");
    const before = await r.describe();
    await evictDurableObject(r);
    const after = await room("desc-reset").describe();
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(after.started_at).toBeGreaterThanOrEqual(before.started_at);
    expect(after).toMatchObject({ id: before.id, name: "desc-reset", stored_name: "desc-reset", max_seq: before.max_seq, alarm_at: before.alarm_at });
  });

  it("setName is idempotent and survives a reset", async () => {
    const r = room("named");
    await r.setName("named");
    await r.setName("named");
    await evictDurableObject(r);
    expect((await room("named").status()).name).toBe("named");
  });

  it("the idle alarm starts one archive Workflow per (room, max_seq)", async () => {
    const r = room("idle");
    await r.setName("idle");
    const { seq } = await r.post("a-1", "dan", "archive me");
    expect(await runDurableObjectAlarm(r)).toBe(true); // a post scheduled it
    const id = `archive-idle-${seq}-idle`;
    const inst = await env.ARCHIVE.get(id);
    expect((await inst.status()).status).toBeDefined();
    // Same idle point again: idempotent, same id, no second instance.
    expect(await r.startArchive("idle")).toBe(id);
  });

  it("the idle alarm on an empty room does nothing", async () => {
    const r = room("empty");
    await r.setName("empty");
    // No post, so no alarm is scheduled.
    expect(await runDurableObjectAlarm(r)).toBe(false);
  });

  it("chaos: throw fails the request and leaves the object alive", async () => {
    const r = room("chaos-throw");
    await r.setName("chaos-throw");
    const before = (await r.status()).incarnation;
    await expect(r.chaos("throw")).rejects.toThrow(/injected throw/);
    expect((await r.status()).incarnation).toBe(before);
  });

  it("chaos: abort resets the object; SQLite is intact", async () => {
    const r = room("chaos-abort");
    await r.setName("chaos-abort");
    await r.post("keep", "dan", "durable");
    const before = (await r.status()).incarnation;
    await expect(r.chaos("abort")).rejects.toThrow();
    const r2 = room("chaos-abort");
    expect((await r2.status()).incarnation).not.toBe(before);
    expect((await r2.history(0, 10)).map((m) => m.msg_id)).toEqual(["keep"]);
  });
});
