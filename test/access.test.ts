/**
 * Cloudflare Access JWT verification. The JWKS endpoint is stubbed; keys are
 * generated per run so no fixture can go stale.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccessError, verifyAccess } from "../src/access";
import { installSigner, now, team, userClaims, type Signer } from "./helpers/jwt";

const env = { ACCESS_AUD: "aud-1", ACCESS_TEAM: team } as Env;
let signer: Signer;

beforeAll(async () => {
  signer = await installSigner();
});
afterEach(() => signer.setJwksStatus(200));

const req = (token: string | null) =>
  new Request("http://x/api", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
const good = userClaims;
const denied = async (token: string | null, reason: string, e: Env = env) => {
  const err = await verifyAccess(req(token), e).catch((x) => x);
  expect(err).toBeInstanceOf(AccessError);
  expect((err as Error).message).toBe(reason);
};

describe("verifyAccess", () => {
  it("is disabled when ACCESS_AUD is empty (local dev)", async () => {
    expect(await verifyAccess(req(null), { ...env, ACCESS_AUD: "" } as Env)).toBeNull();
  });

  it("identifies a person by email and fetches the JWKS once per isolate", async () => {
    signer.fetched.length = 0;
    expect(await verifyAccess(req(await signer.sign(good())), env)).toEqual({ id: "dan@example.com", kind: "user" });
    expect(await verifyAccess(req(await signer.sign(good())), env)).toEqual({ id: "dan@example.com", kind: "user" });
    expect(signer.fetched.length).toBeLessThanOrEqual(1);
    if (signer.fetched.length) expect(signer.fetched[0]).toBe(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  });

  it("identifies a service token by common_name", async () => {
    const t = await signer.sign({ ...good(), email: undefined, common_name: "rooms-drills" });
    expect(await verifyAccess(req(t), env)).toEqual({ id: "rooms-drills", kind: "service" });
  });

  it("accepts a scalar aud", async () => {
    expect(await verifyAccess(req(await signer.sign({ ...good(), aud: "aud-1" })), env)).toMatchObject({ kind: "user" });
  });

  it("accepts nbf slightly in the future (clock skew) and rejects it beyond a minute", async () => {
    expect(await verifyAccess(req(await signer.sign({ ...good(), nbf: now() + 30 })), env)).toMatchObject({ kind: "user" });
    await denied(await signer.sign({ ...good(), nbf: now() + 120 }), "token not yet valid");
  });

  it("rejects everything it should, with a specific reason", async () => {
    await denied(null, "missing Access token");
    await denied("a.b", "malformed token");
    await denied(await signer.sign(good(), "k1", "HS256"), "unexpected alg HS256");
    await denied(await signer.sign({ ...good(), aud: "other" }), "aud mismatch");
    await denied(await signer.sign({ ...good(), iss: "https://evil.cloudflareaccess.com" }), "iss mismatch");
    await denied(await signer.sign({ ...good(), exp: now() - 1 }), "token expired");
    await denied(await signer.sign({ ...good(), exp: now() }), "token expired");
    await denied((await signer.sign(good())).slice(0, -6) + "AAAAAA", "bad signature");
    await denied(await signer.sign({ ...good(), email: undefined }), "no identity in token");
  });

  it("refetches the JWKS for an unknown kid (key rotation) and still rejects it if absent", async () => {
    signer.fetched.length = 0;
    await denied(await signer.sign(good(), "k2"), "unknown kid k2");
    expect(signer.fetched).toHaveLength(1);
  });

  it("reports a JWKS fetch failure", async () => {
    signer.setJwksStatus(500);
    await denied(await signer.sign(good(), "k3"), "jwks fetch 500");
  });
});
