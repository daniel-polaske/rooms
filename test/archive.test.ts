/**
 * ArchiveWorkflow end to end: export -> grace -> verify -> mark, against the
 * real RoomDO, R2 and DirectoryDO. Sleeps and retry delays are disabled, so
 * the pipeline runs in milliseconds; nothing else is mocked.
 */
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface Output { room: string; reason: string; key: string; count: number; max_seq: number; etag: string; bytes: number }

describe("ArchiveWorkflow", () => {
  it("archives a room into R2, verifies the etag, and marks the directory", async () => {
    const room = env.ROOM.getByName("wf");
    await room.setName("wf");
    for (let i = 0; i < 3; i++) await room.post(`w-${i}`, "dan", `msg ${i}`);
    const { max_seq } = await room.status();
    const id = `archive-wf-${max_seq}-manual`;

    const instance = await introspectWorkflowInstance(env.ARCHIVE, id);
    try {
      await instance.modify(async (m) => {
        await m.disableSleeps();
      });
      expect(await room.startArchive("manual")).toBe(id);
      await instance.waitForStatus("complete");
      const out = (await instance.getOutput()) as Output;
      expect(out).toMatchObject({ room: "wf", reason: "manual", count: 3, max_seq, key: `rooms/wf/${id}.json` });

      const obj = await env.ARCHIVES.get(out.key);
      expect(obj).not.toBeNull();
      expect(obj!.etag).toBe(out.etag);
      expect(obj!.customMetadata).toMatchObject({ room: "wf", max_seq: String(max_seq), instance: id });
      const body = JSON.parse(await obj!.text()) as { count: number; messages: { msg_id: string }[] };
      expect(body.count).toBe(3);
      expect(body.messages.map((m) => m.msg_id)).toEqual(["w-0", "w-1", "w-2"]);
      expect(out.bytes).toBe(obj!.size);

      const row = (await env.DIRECTORY.getByName("main").list()).find((r) => r.name === "wf");
      expect(row).toMatchObject({ archived: 1, archive_key: out.key });
    } finally {
      await instance.dispose();
    }
  });

  it("pages the export in bounded reads when the room exceeds one page", async () => {
    const room = env.ROOM.getByName("big");
    await room.setName("big");
    for (let i = 0; i < 503; i++) await room.post(`b-${i}`, "dan", `msg ${i}`);
    const { max_seq } = await room.status();
    const id = `archive-big-${max_seq}-idle`;
    const instance = await introspectWorkflowInstance(env.ARCHIVE, id);
    try {
      await instance.modify(async (m) => {
        await m.disableSleeps();
      });
      await room.startArchive("idle");
      await instance.waitForStatus("complete");
      const out = (await instance.getOutput()) as Output;
      expect(out).toMatchObject({ count: 503, max_seq, reason: "idle" });
      const body = JSON.parse(await (await env.ARCHIVES.get(out.key))!.text()) as { messages: { seq: number }[] };
      expect(body.messages).toHaveLength(503);
      for (let i = 1; i < body.messages.length; i++) expect(body.messages[i].seq).toBeGreaterThan(body.messages[i - 1].seq);
    } finally {
      await instance.dispose();
    }
  });

  it("fails loudly in verify when the archive is not what export wrote", async () => {
    const room = env.ROOM.getByName("broken");
    await room.setName("broken");
    await room.post("x-1", "dan", "one");
    const { max_seq } = await room.status();
    const id = `archive-broken-${max_seq}-manual`;
    const instance = await introspectWorkflowInstance(env.ARCHIVE, id);
    try {
      await instance.modify(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
        // Pretend export wrote an object that is not there: verify must not pass silently.
        await m.mockStepResult({ name: "export" }, { key: "rooms/broken/missing.json", count: 1, max_seq, etag: "nope" });
      });
      await room.startArchive("manual");
      await instance.waitForStatus("errored");
      expect((await instance.getError()).message).toMatch(/archive missing/);
      const row = (await env.DIRECTORY.getByName("main").list()).find((r) => r.name === "broken");
      expect(row?.archived ?? 0).toBe(0); // mark never ran
    } finally {
      await instance.dispose();
    }
  });
});
