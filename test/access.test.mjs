import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
const fetched = [];
const { verifyAccess, AccessError } = await import("../dist-test/access.mjs");
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["sign","verify"]);
const jwk = await crypto.subtle.exportKey("jwk", publicKey);
globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response(JSON.stringify({ keys: [{ kid: "k1", kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }] })); };
const b64u = (b) => Buffer.from(b).toString("base64url");
async function sign(claims, kid = "k1") {
  const h = b64u(JSON.stringify({ alg: "RS256", kid })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
const env = { ACCESS_AUD: "aud-1", ACCESS_TEAM: "hypnagogia" };
const now = Math.floor(Date.now()/1000);
const req = (t) => new Request("http://x/api", { headers: t ? { "cf-access-jwt-assertion": t } : {} });
const good = { aud: ["aud-1"], iss: "https://hypnagogia.cloudflareaccess.com", exp: now + 300, email: "dan@example.com" };
const cases = [
  ["user token",     await sign(good), { id: "dan@example.com", kind: "user" }],
  ["service token",  await sign({ ...good, email: undefined, common_name: "rooms-drills" }), { id: "rooms-drills", kind: "service" }],
  ["missing header", null, "missing Access token"],
  ["wrong aud",      await sign({ ...good, aud: "other" }), "aud mismatch"],
  ["wrong iss",      await sign({ ...good, iss: "https://evil.cloudflareaccess.com" }), "iss mismatch"],
  ["expired",        await sign({ ...good, exp: now - 1 }), "token expired"],
  ["tampered",       (await sign(good)).slice(0, -6) + "AAAAAA", "bad signature"],
  ["unknown kid",    await sign(good, "k2"), "unknown kid k2"],
];
let fail = 0;
for (const [name, tok, want] of cases) {
  try { const r = await verifyAccess(req(tok), env); const ok = JSON.stringify(r) === JSON.stringify(want); console.log(ok?"ok  ":"FAIL", name, JSON.stringify(r)); if(!ok) fail++; }
  catch (e) { const ok = e instanceof AccessError && e.message === want; console.log(ok?"ok  ":"FAIL", name, "->", e.message); if(!ok) fail++; }
}
console.log("disabled (ACCESS_AUD empty):", await verifyAccess(req(null), { ACCESS_AUD: "" }));
console.log("JWKS fetches:", fetched.length, "from", fetched[0]);
process.exit(fail);
