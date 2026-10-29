/**
 * ArchiveWorkflow: durable execution.
 *
 * Each step.do() result is checkpointed. If the Workflow's isolate dies
 * between steps (deploy, eviction, your bug), it resumes after the last
 * completed step instead of re-running "export". Same trick as the DO:
 * make the durable boundary explicit and let the process die between them.
 *
 * Stage 3 TODO: add a step that writes the export to R2 (add an r2_buckets
 * binding to wrangler.jsonc). Left out so Stage 0-2 deploys with nothing
 * but Workers, DOs, Queues and Workflows.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { log } from "./log";

export interface ArchiveParams { room: string }

export class ArchiveWorkflow extends WorkflowEntrypoint<Env, ArchiveParams> {
  async run(event: WorkflowEvent<ArchiveParams>, step: WorkflowStep) {
    const { room } = event.payload;
    const wf = { do: "ArchiveWorkflow", instance: event.instanceId, room };

    const rows = await step.do(
      "export",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        log("wf.step", { ...wf, step: "export" });
        const stub = this.env.ROOM.getByName(room);
        const msgs = await stub.history(0, 500);
        return { count: msgs.length, max_seq: msgs.at(-1)?.seq ?? 0 };
      },
    );

    // Grace period: a room that wakes up during this hour is un-archived by
    // the next bump(), because bump() sets archived = 0.
    await step.sleep("grace", "1 hour");

    await step.do("mark", async () => {
      log("wf.step", { ...wf, step: "mark", ...rows });
      await this.env.DIRECTORY.getByName("main").archive(room);
    });

    return { room, ...rows };
  }
}
