/**
 * The Router with Access enabled: a verified identity wins over whatever the
 * client claims, on HTTP and on the socket; a bad token is a 401 from the
 * Worker itself, before any object is touched.
 */
import { env as realEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { installSigner, team, userClaims, type Signer } from "./helpers/jwt";

const env = { ...realEnv, ACCESS_AUD: "aud-1", ACCESS_TEAM: team } as Env;
type IncomingRequest = Parameters<typeof worker.fetch>[0];
let signer: Signer;
beforeAll(async () => {
  signer = await installSigner();
});

const call = async (path: string, token: string | null, init: RequestInit = {}) => {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (token) headers.set("cf-access-jwt-assertion", token);
  const res = await worker.fetch(new Request(`http://rooms.test${path}`, { ...init, headers }) as unknown as IncomingRequest, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

describe("Router behind Access", () => {
  it("denies a missing or forged token with 401 and a reason", async () => {
    const res = await call("/api/rooms/secure", null);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized", reason: "missing Access token" });
    const forged = (await signer.sign(userClaims())).slice(0, -6) + "AAAAAA";
    expect(await (await call("/api/rooms/secure", forged)).json()).toMatchObject({ reason: "bad signature" });
  });

  it("a verified person is the author, whatever the body says", async () => {
    const token = await signer.sign(userClaims("dan@example.com"));
    const res = await call("/api/rooms/secure/messages", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_id: "sec-1", author: "mallory", body: "hi" }),
    });
    expect(res.status).toBe(201);
    expect(await (await call("/api/rooms/secure/messages", token)).json()).toMatchObject([{ msg_id: "sec-1", author: "dan@example.com" }]);
  });

  it("a service token keeps the body's author", async () => {
    const token = await signer.sign({ ...userClaims(), email: undefined, common_name: "rooms-drills" });
    await call("/api/rooms/svc/messages", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_id: "svc-1", author: "drill", body: "hi" }),
    });
    expect(await (await call("/api/rooms/svc/messages", token)).json()).toMatchObject([{ msg_id: "svc-1", author: "drill" }]);
  });

  it("tags the socket with the verified identity, not the ?author= claim", async () => {
    const token = await signer.sign(userClaims("dan@example.com"));
    const res = await call("/api/rooms/secure-ws/ws?author=mallory", token, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const events: { type: string; author?: string }[] = [];
    const got = new Promise<void>((resolve) => ws.addEventListener("message", (e) => { events.push(JSON.parse(e.data as string)); if (events.length === 3) resolve(); }));
    ws.send(JSON.stringify({ type: "post", msg_id: "ws-sec-1", body: "hi" }));
    await got;
    expect(events[0]).toMatchObject({ type: "hello" });
    expect(events[1]).toMatchObject({ type: "message", author: "dan@example.com" });
    expect(events[2]).toMatchObject({ type: "ack", msg_id: "ws-sec-1" });
    ws.close(1000, "done");
  });
});
