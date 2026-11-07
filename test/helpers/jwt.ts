/**
 * Mints Cloudflare Access-shaped RS256 tokens for tests, and stubs the JWKS
 * endpoint so `verifyAccess` can validate them. Keys are generated per run.
 */
import { vi } from "vitest";

export const team = "hypnagogia";
export const iss = `https://${team}.cloudflareaccess.com`;

const b64u = (s: string | ArrayBuffer) =>
  btoa(typeof s === "string" ? s : String.fromCharCode(...new Uint8Array(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface Signer {
  sign(claims: Record<string, unknown>, kid?: string, alg?: string): Promise<string>;
  fetched: string[];
  setJwksStatus(status: number): void;
}

/** Generates a key pair, publishes it through a stubbed `fetch`, and returns a signer. */
export async function installSigner(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwks = { keys: [{ kid: "k1", kty: pub.kty, n: pub.n, e: pub.e, alg: "RS256" }] };
  const fetched: string[] = [];
  let status = 200;
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    fetched.push(String(url));
    return new Response(JSON.stringify(jwks), { status });
  });
  return {
    fetched,
    setJwksStatus: (s) => { status = s; },
    async sign(claims, kid = "k1", alg = "RS256") {
      const h = b64u(JSON.stringify({ alg, kid }));
      const p = b64u(JSON.stringify(claims));
      const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64u(sig)}`;
    },
  };
}

export const now = () => Math.floor(Date.now() / 1000);
export const userClaims = (email = "dan@example.com") => ({ aud: ["aud-1"], iss, exp: now() + 300, email });
