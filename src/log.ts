/**
 * Structured logging + hand-carried trace context.
 *
 * Every event is one JSON line with a fixed vocabulary (`event` is dotted:
 * room.post, room.start, queue.retry, wf.step ...). Workers Logs indexes the
 * keys, so you can filter on any of them in the dashboard or `wrangler tail`.
 *
 * Trace context is carried by hand because Queue hops and Workflow steps
 * break automatic propagation. The Router mints a W3C traceparent; everything
 * downstream receives it as a plain argument and echoes it in its log lines.
 */

export interface Trace {
  trace_id: string;
  span_id: string;
}

export function newTrace(parent?: string | null): Trace {
  // traceparent: 00-<32 hex trace>-<16 hex span>-<2 hex flags>
  const m = parent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return {
    trace_id: m ? m[1] : hex(16),
    span_id: hex(8),
  };
}

export function childSpan(t: Trace): Trace {
  return { trace_id: t.trace_id, span_id: hex(8) };
}

export function traceparent(t: Trace): string {
  return `00-${t.trace_id}-${t.span_id}-01`;
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  // console.log with a JSON string is what Workers Logs parses into fields.
  console.log(JSON.stringify({ event, ts: Date.now(), ...fields }));
}

export function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
