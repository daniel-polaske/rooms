/**
 * Cucumber world: one HTTP client per scenario against BASE (default: the
 * local wrangler dev). The chaos token and Access service-token headers come
 * from .dev.vars, exactly as scripts/drill-kill.mjs reads them.
 */
import { setWorldConstructor, setDefaultTimeout } from "@cucumber/cucumber";
import { accessHeaders, loadDevVars } from "../../scripts/drill-kill.mjs";

setDefaultTimeout(90_000);

const vars = loadDevVars();

export class RoomsWorld {
  constructor() {
    this.base = process.env.BASE ?? "http://localhost:8787";
    this.token = vars.CHAOS_TOKEN ?? "dev";
    this.auth = accessHeaders(vars);
    this.room = null;
    this.last = null; // { status, body, headers }
    this.incarnation = null;
    this.drillResult = null;
  }

  async api(path, init = {}) {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: { ...this.auth, ...(init.headers ?? {}) } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    this.last = { status: res.status, body, headers: res.headers };
    return this.last;
  }

  post(msg_id, body, author = "cuke") {
    return this.api(`/api/rooms/${this.room}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_id, author, body }),
    });
  }

  async history() {
    const all = [];
    let after = 0;
    for (;;) {
      const { body: page } = await this.api(`/api/rooms/${this.room}/messages?after=${after}&limit=500`);
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      after = page.at(-1).seq;
    }
    return all;
  }

  async status() {
    return (await this.api(`/api/rooms/${this.room}`)).body;
  }

  chaos(mode, withToken) {
    return this.api(`/api/rooms/${this.room}/chaos?mode=${mode}`, {
      method: "POST",
      headers: withToken ? { "x-chaos-token": this.token } : {},
    });
  }

  /** Poll until `check(value)` is truthy or the deadline passes. */
  async eventually(seconds, fetchValue, check) {
    const deadline = Date.now() + seconds * 1000;
    let value;
    for (;;) {
      value = await fetchValue();
      if (check(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out after ${seconds}s; last value: ${JSON.stringify(value)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

setWorldConstructor(RoomsWorld);
