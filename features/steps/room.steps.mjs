import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";
import { drill } from "../../scripts/drill-kill.mjs";

Given("a fresh room", async function () {
  this.room = `cuke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const st = await this.status();
  assert.equal(this.last.status, 200, `status for a new room: ${JSON.stringify(this.last.body)}`);
  this.incarnation = st.incarnation;
});

When("I post a message with msg_id {string} and body {string}", async function (msgId, body) {
  await this.post(msgId, body);
  assert.ok([200, 201].includes(this.last.status), `post failed: ${this.last.status} ${JSON.stringify(this.last.body)}`);
});

When("I post {int} messages", async function (n) {
  for (let i = 0; i < n; i++) {
    await this.post(`m-${i}`, `message ${i}`);
    assert.equal(this.last.status, 201, `post ${i}: ${this.last.status} ${JSON.stringify(this.last.body)}`);
  }
});

When("I post {int} messages while killing the room every {int} posts", async function (n, k) {
  this.drillResult = await drill({ base: this.base, room: this.room, n, k, token: this.token, auth: this.auth });
});

When("I kill the room", async function () {
  await this.chaos("abort", true); // 500 with retryable: the object is gone, SQLite is not
});

When("I request chaos {string} without the token", async function (mode) {
  await this.chaos(mode, false);
});

When("I request chaos {string} with the token", async function (mode) {
  await this.chaos(mode, true);
});

When("I GET {string}", async function (path) {
  await this.api(path);
});

Then("the last response status is {int}", function (status) {
  assert.equal(this.last.status, status, `body: ${JSON.stringify(this.last.body)}`);
});

Then("the last response is marked duplicate", function () {
  assert.equal(this.last.body.duplicate, true);
});

Then("the last response carries a trace id", function () {
  assert.match(String(this.last.body.trace_id), /^[0-9a-f]{32}$/);
});

Then("the room history has exactly {int} message(s)", async function (n) {
  assert.equal((await this.history()).length, n);
});

Then("the only message has body {string}", async function (body) {
  const [m] = await this.history();
  assert.equal(m.body, body);
});

Then("the history seqs are strictly increasing", async function () {
  const hist = await this.history();
  for (let i = 1; i < hist.length; i++) assert.ok(hist[i].seq > hist[i - 1].seq, `seq ${hist[i].seq} after ${hist[i - 1].seq}`);
});

Then("the room reports {int} messages", async function (n) {
  assert.equal((await this.status()).messages, n);
});

Then("every acknowledged msg_id appears in history exactly once", function () {
  const r = this.drillResult;
  assert.deepEqual(r.missingAcked, [], `lost acknowledged writes: ${r.missingAcked.length}`);
  assert.deepEqual(r.duplicates, [], `duplicated msg_ids: ${r.duplicates.length}`);
  assert.ok(r.acked > 0 && r.inHistory >= r.acked, JSON.stringify(r));
});

Then("the object was reset at least once", async function () {
  assert.ok(this.drillResult.resets > 0);
  assert.notEqual((await this.status()).incarnation, this.incarnation);
});

Then("the room has a new incarnation", async function () {
  assert.notEqual((await this.status()).incarnation, this.incarnation);
});
