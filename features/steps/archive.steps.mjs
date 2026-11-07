import assert from "node:assert/strict";
import { When, Then } from "@cucumber/cucumber";

When("I start an archive with the token", async function () {
  await this.api(`/api/rooms/${this.room}/archive`, { method: "POST", headers: { "x-chaos-token": this.token } });
  this.instance = this.last.body?.instance;
});

When("I start an archive without the token", async function () {
  await this.api(`/api/rooms/${this.room}/archive`, { method: "POST" });
});

Then("within {int} seconds the directory lists the room with {int} messages", async function (seconds, n) {
  await this.eventually(
    seconds,
    async () => (await this.api("/api/rooms")).body,
    (rooms) => Array.isArray(rooms) && rooms.some((r) => r.name === this.room && r.messages === n),
  );
});

Then("within {int} seconds the archive status is {string}", async function (seconds, status) {
  assert.ok(this.instance, "no archive instance id from the 202");
  await this.eventually(
    seconds,
    async () => (await this.api(`/api/archives/${this.instance}`)).body,
    (st) => st?.status === status || st?.status === "errored",
  );
  assert.equal(this.last.body.status, status, JSON.stringify(this.last.body));
});

Then("the archive body lists {int} messages", async function (n) {
  const { status, body } = await this.api(`/api/archives/${this.instance}/body`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.count, n);
  assert.equal(body.messages.length, n);
  assert.equal(body.room, this.room);
});

Then("within {int} seconds the directory lists the room as archived", async function (seconds) {
  await this.eventually(
    seconds,
    async () => (await this.api("/api/rooms")).body,
    (rooms) => Array.isArray(rooms) && rooms.some((r) => r.name === this.room && r.archived === 1 && r.archive_key),
  );
});
