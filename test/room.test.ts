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
