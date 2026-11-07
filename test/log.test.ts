import { describe, expect, it, vi } from "vitest";
import { childSpan, hex, log, newTrace, traceparent } from "../src/log";

describe("trace context", () => {
  it("continues a valid traceparent and mints a new span", () => {
    const t = newTrace("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    expect(t.trace_id).toBe("0123456789abcdef0123456789abcdef");
    expect(t.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(t.span_id).not.toBe("0123456789abcdef");
  });

  it("starts a fresh trace when the header is missing or malformed", () => {
    const valid = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    for (const bad of [null, undefined, "", "garbage", "01-0123456789abcdef0123456789abcdef-0123456789abcdef-01", "00-short-0123456789abcdef-01", `x${valid}`, `${valid}x`]) {
      expect(newTrace(bad).trace_id).not.toBe("0123456789abcdef0123456789abcdef");
      const t = newTrace(bad);
      expect(t.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(t.span_id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("childSpan keeps the trace and changes the span", () => {
    const t = newTrace(null);
    const c = childSpan(t);
    expect(c.trace_id).toBe(t.trace_id);
    expect(c.span_id).not.toBe(t.span_id);
  });

  it("traceparent round-trips", () => {
    const t = newTrace(null);
    const header = traceparent(t);
    expect(header).toBe(`00-${t.trace_id}-${t.span_id}-01`);
    expect(newTrace(header).trace_id).toBe(t.trace_id);
  });

  it("hex(n) yields 2n lowercase hex characters, different each call", () => {
    expect(hex(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(hex(16)).toHaveLength(32);
    expect(hex(8)).not.toBe(hex(8));
  });

  it("log() writes one JSON line with event and ts first", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("unit.test", { a: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(Object.keys(line)).toEqual(["event", "ts", "a"]);
    expect(line).toMatchObject({ event: "unit.test", a: 1 });
    expect(typeof line.ts).toBe("number");
    spy.mockRestore();
  });
});
