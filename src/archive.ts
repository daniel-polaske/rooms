/**
 * ArchiveWorkflow: durable execution.
 *
 * A Workflow is a function whose progress is persisted. Each `step.do()`
 * runs at most to completion once per attempt; its *return value* is written
 * to storage before the next line executes. If the isolate running `run()`
 * dies at any point (deploy, eviction, exceeded CPU, your bug), the platform
 * starts `run()` again from the top, but every step that already completed
 * returns its stored value instantly instead of re-running. That is "replay".
 *
 * Two rules fall out of this:
 *   R1  Everything with a side effect lives inside a step.do(). Code between
 *       steps re-executes on every replay, so it must be pure (or harmless).
 *   R2  A step's return value is serialised to storage: keep it small and
 *       JSON-shaped. Pass *keys* between steps, not payloads.
 *
 * Pipeline:   export (paginated, into R2)  ->  sleep(grace)  ->  verify  ->  mark
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { log } from "./log";

export interface ArchiveParams { room: string; reason?: "idle" | "manual" }

const PAGE = 500; // rows per history() call: bounded rows-read per invocation

export class ArchiveWorkflow extends WorkflowEntrypoint<Env, ArchiveParams> {
  async run(event: WorkflowEvent<ArchiveParams>, step: WorkflowStep) {
    const { room, reason = "idle" } = event.payload;
    const wf = { do: "ArchiveWorkflow", instance: event.instanceId, room };
    const key = `rooms/${room}/${event.instanceId}.json`;

    // --- export ---------------------------------------------------------
    // Pages through the room in bounded reads and streams them into one R2
    // object. If this step fails halfway (DO reset, network), it re-runs from
    // scratch on retry: R2 put() is idempotent on key, so a partial upload is
    // simply overwritten. Return value: counts + key, never the messages.
    const exported = await step.do(
      "export",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        log("wf.step", { ...wf, step: "export", attempt: "start" });
        const stub = this.env.ROOM.getByName(room);
        const messages: unknown[] = [];
        let after = 0;
        for (;;) {
          const page = await stub.history(after, PAGE);
          if (!page.length) break;
          messages.push(...page);
          after = page[page.length - 1].seq;
          if (page.length < PAGE) break;
        }
        const body = JSON.stringify({ room, exported_at: Date.now(), reason, count: messages.length, messages });
        const obj = await this.env.ARCHIVES.put(key, body, {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { room, max_seq: String(after), instance: event.instanceId },
        });
        log("wf.step", { ...wf, step: "export", count: messages.length, max_seq: after, bytes: body.length, etag: obj.etag });
        return { key, count: messages.length, max_seq: after, etag: obj.etag };
      },
    );

    // --- grace ----------------------------------------------------------
    // A durable sleep: the instance is unloaded, costs nothing while waiting,
    // and resumes here. A room that wakes up during this window gets
    // un-archived by the next DirectoryDO.bump(), which sets archived = 0.
    await step.sleep("grace", (this.env.ARCHIVE_GRACE || "1 hour") as WorkflowSleepDuration);

    // --- verify ---------------------------------------------------------
    // Read-your-writes across a different service: confirm the object is
    // there and is the one we wrote (etag). Cheap, and it turns a silent
    // failure in R2 into a loud one here.
    const verified = await step.do("verify", { retries: { limit: 2, delay: "5 seconds" } }, async () => {
      const head = await this.env.ARCHIVES.head(exported.key);
      if (!head) throw new Error(`archive missing: ${exported.key}`);
      if (head.etag !== exported.etag) throw new Error(`archive etag mismatch: ${head.etag} != ${exported.etag}`);
      log("wf.step", { ...wf, step: "verify", bytes: head.size });
      return { bytes: head.size };
    });

    // --- mark -----------------------------------------------------------
    // The only step that mutates application state. Idempotent: UPDATE ... SET archived = 1.
    await step.do("mark", async () => {
      await this.env.DIRECTORY.getByName("main").archive(room, exported.key);
      log("wf.step", { ...wf, step: "mark", key: exported.key });
    });

    log("wf.done", { ...wf, ...exported, ...verified });
    return { room, reason, ...exported, ...verified };
  }
}
