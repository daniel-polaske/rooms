/**
 * Generic HTTP and WebSocket steps. Written for the eval graders
 * (evals/tasks/<id>/grader.feature) but usable by any scenario.
 *
 * Paths may contain placeholders resolved from the scenario's world:
 *   {room}        the current fresh room
 *   {instance}    the last archive instance id
 *   {last_seq}    the seq of the last acknowledged post
 *   {first_seq}   the seq of the first acknowledged post in this scenario
 */
import assert from "node:assert/strict";
import { Given, When, Then, After } from "@cucumber/cucumber";

function resolve(world, path) {
  return path
    .replaceAll("{room}", world.room ?? "")
    .replaceAll("{instance}", world.instance ?? "")
    .replaceAll("{last_seq}", String(world.lastSeq ?? ""))
    .replaceAll("{first_seq}", String(world.firstSeq ?? ""));
}

function getPath(obj, path) {
  if (path === "" || path === ".") return obj;
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function rememberSeq(world) {
  const seq = world.last?.body?.seq;
  if (typeof seq === "number") {
    world.lastSeq = seq;
    if (world.firstSeq == null) world.firstSeq = seq;
  }
}

// ---------------------------------------------------------------- requests

When("I send a {word} request to {string}", async function (method, path) {
  await this.api(resolve(this, path), { method });
  rememberSeq(this);
});

When("I send a {word} request to {string} with the token", async function (method, path) {
  await this.api(resolve(this, path), { method, headers: { "x-chaos-token": this.token } });
  rememberSeq(this);
});

When("I send a {word} request to {string} with body:", async function (method, path, body) {
  await this.api(resolve(this, path), { method, headers: { "content-type": "application/json" }, body });
  rememberSeq(this);
});

When("I send a {word} request to {string} with the token and body:", async function (method, path, body) {
  await this.api(resolve(this, path), { method, headers: { "content-type": "application/json", "x-chaos-token": this.token }, body });
  rememberSeq(this);
});

When("I post {int} messages as {string}", async function (n, author) {
  for (let i = 0; i < n; i++) {
    await this.post(`${author}-${i}-${Math.random().toString(36).slice(2, 6)}`, `message ${i} from ${author}`, author);
    assert.equal(this.last.status, 201, `post ${i} as ${author}: ${this.last.status} ${JSON.stringify(this.last.body)}`);
    rememberSeq(this);
  }
});

When("I post a message as {string} with body {string}", async function (author, body) {
  await this.post(`${author}-${Math.random().toString(36).slice(2, 8)}`, body, author);
  rememberSeq(this);
});

When("I post a message with a body of {int} bytes", async function (bytes) {
  await this.post(`sized-${bytes}-${Math.random().toString(36).slice(2, 6)}`, "x".repeat(bytes));
  rememberSeq(this);
});

Given("{int} fresh rooms with one message each", async function (n) {
  this.rooms = [];
  for (let i = 0; i < n; i++) {
    const name = `cuke-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 5)}`;
    this.rooms.push(name);
    await this.api(`/api/rooms/${name}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_id: `${name}-1`, author: "cuke", body: "hello" }),
    });
    assert.equal(this.last.status, 201, JSON.stringify(this.last.body));
  }
});

// --------------------------------------------------------------- responses

Then("the response header {string} is present", function (name) {
  assert.ok(this.last.headers.get(name) != null, `missing header ${name}`);
});

Then("the response header {string} is {string}", function (name, value) {
  assert.equal(this.last.headers.get(name), value);
});

Then("the response header {string} contains {string}", function (name, value) {
  assert.ok((this.last.headers.get(name) ?? "").includes(value), `header ${name}: ${this.last.headers.get(name)}`);
});

Then("the response JSON field {string} is {int}", function (path, n) {
  assert.equal(getPath(this.last.body, path), n, JSON.stringify(this.last.body));
});

Then("the response JSON field {string} is {string}", function (path, s) {
  assert.equal(getPath(this.last.body, path), s, JSON.stringify(this.last.body));
});

Then("the response JSON field {string} is the boolean {word}", function (path, word) {
  assert.equal(getPath(this.last.body, path), word === "true", JSON.stringify(this.last.body));
});

Then("the response JSON field {string} is at least {int}", function (path, n) {
  const v = getPath(this.last.body, path);
  assert.ok(typeof v === "number" && v >= n, `${path} = ${v}, want >= ${n}`);
});

Then("the response JSON field {string} is present", function (path) {
  assert.notEqual(getPath(this.last.body, path), undefined, JSON.stringify(this.last.body));
});

Then("the response JSON field {string} is absent", function (path) {
  assert.equal(getPath(this.last.body, path), undefined, JSON.stringify(this.last.body));
});

Then("the response JSON array has {int} item(s)", function (n) {
  assert.ok(Array.isArray(this.last.body), `not an array: ${JSON.stringify(this.last.body)}`);
  assert.equal(this.last.body.length, n);
});

Then("the response JSON array {string} has {int} item(s)", function (path, n) {
  const v = getPath(this.last.body, path);
  assert.ok(Array.isArray(v), `${path} is not an array: ${JSON.stringify(this.last.body)}`);
  assert.equal(v.length, n);
});

Then("the response body has {int} line(s)", function (n) {
  const text = typeof this.last.body === "string" ? this.last.body : JSON.stringify(this.last.body);
  assert.equal(text.split("\n").filter((l) => l.trim()).length, n);
});

Then("every line of the response body is JSON with a field {string}", function (field) {
  const text = typeof this.last.body === "string" ? this.last.body : JSON.stringify(this.last.body);
  for (const line of text.split("\n").filter((l) => l.trim())) {
    const obj = JSON.parse(line);
    assert.notEqual(obj[field], undefined, `line without ${field}: ${line}`);
  }
});

// --------------------------------------------------------------- directory

Then("within {int} seconds the directory lists all of my rooms", async function (seconds) {
  await this.eventually(
    seconds,
    async () => (await this.api("/api/rooms?limit=500")).body,
    (rooms) => Array.isArray(rooms) && this.rooms.every((name) => rooms.some((r) => r.name === name)),
  );
});

Then("paging through the room list {int} at a time yields all of my rooms exactly once", async function (pageSize) {
  const seen = new Map();
  let cursor = null;
  for (let page = 0; page < 1000; page++) {
    const { status, body, headers } = await this.api(`/api/rooms?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body) && body.length <= pageSize, `page ${page}: ${JSON.stringify(body)}`);
    for (const r of body) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
    cursor = headers.get("x-next-cursor");
    if (!cursor) break;
  }
  for (const name of this.rooms) assert.equal(seen.get(name), 1, `room ${name} seen ${seen.get(name) ?? 0} times`);
});

Then("the per-shard room counts sum to the total and at least {int} shards are non-empty", function (n) {
  const { per_shard, rooms } = this.last.body;
  assert.ok(Array.isArray(per_shard), JSON.stringify(this.last.body));
  const sum = per_shard.reduce((a, s) => a + s.rooms, 0);
  assert.equal(sum, rooms, `per_shard sums to ${sum}, total ${rooms}`);
  assert.ok(per_shard.filter((s) => s.rooms > 0).length >= n, JSON.stringify(per_shard));
});

Then("within {int} seconds an idle archive for the room has started", async function (seconds) {
  const { max_seq } = await this.status();
  const id = `archive-${this.room}-${max_seq}-idle`;
  await this.eventually(seconds, async () => (await this.api(`/api/archives/${id}`)).status, (status) => status === 200);
});

// -------------------------------------------------------------- websockets

function wsUrl(world, author) {
  return `${world.base.replace(/^http/, "ws")}/api/rooms/${world.room}/ws?author=${encodeURIComponent(author)}`;
}

When("I open a websocket to the room as {string}", async function (author) {
  this.sockets ??= new Map();
  const ws = new WebSocket(wsUrl(this, author));
  const events = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`websocket error for ${author}: ${e.message ?? e}`)), { once: true });
  });
  this.sockets.set(author, { ws, events, cursor: 0 });
});

When("the websocket for {string} posts a message with msg_id {string} and body {string}", function (author, msgId, body) {
  this.sockets.get(author).ws.send(JSON.stringify({ type: "post", msg_id: msgId, body }));
});

When("the websocket for {string} posts a message with a body of {int} bytes and msg_id {string}", function (author, bytes, msgId) {
  this.sockets.get(author).ws.send(JSON.stringify({ type: "post", msg_id: msgId, body: "x".repeat(bytes) }));
});

When("I close the websocket for {string}", async function (author) {
  const s = this.sockets.get(author);
  s.ws.close(1000, "done");
  await new Promise((r) => setTimeout(r, 200));
});

Then("within {int} seconds the websocket for {string} receives an event of type {string}", async function (seconds, author, type) {
  const s = this.sockets.get(author);
  assert.ok(s, `no websocket for ${author}`);
  await this.eventually(
    seconds,
    async () => s.events.slice(s.cursor).find((e) => e.type === type),
    (found) => !!found,
  );
  const idx = s.events.findIndex((e, i) => i >= s.cursor && e.type === type);
  this.lastEvent = s.events[idx];
  s.cursor = idx + 1; // the next "receives" looks past this one
});

Then("that event's field {string} is {int}", function (path, n) {
  assert.equal(getPath(this.lastEvent, path), n, JSON.stringify(this.lastEvent));
});

Then("that event's field {string} is {string}", function (path, s) {
  assert.equal(getPath(this.lastEvent, path), s, JSON.stringify(this.lastEvent));
});

Then("that event's field {string} matches the last seq", function (path) {
  assert.equal(getPath(this.lastEvent, path), this.lastSeq, JSON.stringify(this.lastEvent));
});

After(function () {
  for (const { ws } of this.sockets?.values() ?? []) {
    try { ws.close(); } catch { /* already closed */ }
  }
});
