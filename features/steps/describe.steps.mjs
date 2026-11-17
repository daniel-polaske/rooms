/**
 * Steps for features/describe.feature. Each "I describe the room" keeps its
 * answer, so a scenario can compare two descriptions of the same room.
 */
import assert from "node:assert/strict";
import { When, Then } from "@cucumber/cucumber";

When("I describe the room", async function () {
  await this.api(`/api/rooms/${this.room}/describe`, { headers: { "x-chaos-token": this.token } });
  assert.equal(this.last.status, 200, `describe: ${this.last.status} ${JSON.stringify(this.last.body)}`);
  (this.descriptions ??= []).push(this.last.body);
});

Then("the description names the room as it was addressed", function () {
  const d = this.last.body;
  assert.equal(d.id_name, this.room, "id_name is the name the Router addressed");
  assert.equal(d.name, this.room, "name is what the room's own storage remembers");
});

Then("the description has a 64-digit id and an 8-digit incarnation", function () {
  assert.match(String(this.last.body.id), /^[0-9a-f]{64}$/);
  assert.match(String(this.last.body.incarnation), /^[0-9a-f]{8}$/);
});

Then("the description lists the tables {string} and {string}", function (a, b) {
  const names = (this.last.body.tables ?? []).map((t) => t.name);
  for (const want of [a, b]) assert.ok(names.includes(want), `no table ${want} in ${JSON.stringify(names)}`);
});

Then("the description has an alarm in the future", function () {
  const at = this.last.body.alarm_at;
  assert.ok(typeof at === "number" && at > Date.now(), `alarm_at = ${at}`);
});

Then("both descriptions cost {int} row(s) read", function (n) {
  const [first, second] = this.descriptions.slice(-2);
  assert.equal(first.rows_read, n, `first description: ${JSON.stringify(first)}`);
  assert.equal(second.rows_read, n, `second description: ${JSON.stringify(second)}`);
  assert.ok(second.max_seq > first.max_seq, "the room did grow between the two descriptions");
});

Then("both descriptions have the same id, name and max_seq", function () {
  const [first, second] = this.descriptions.slice(-2);
  for (const k of ["id", "id_name", "name", "max_seq"]) assert.equal(second[k], first[k], `${k} changed across the reset`);
});

Then("the two descriptions have different incarnations", function () {
  const [first, second] = this.descriptions.slice(-2);
  assert.notEqual(second.incarnation, first.incarnation);
  assert.ok(second.started_at >= first.started_at, "the new incarnation started later");
});
