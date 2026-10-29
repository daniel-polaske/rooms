/**
 * Cloudflare Access JWT verification (defense in depth).
 *
 * Access already enforces the policy at the edge before this Worker runs,
 * and stamps every proxied request with `Cf-Access-Jwt-Assertion`. Verifying
 * that token here guards against misconfiguration (a route added later that
 * the Access app does not cover, a path policy that drifts) and gives us the
 * caller's identity for logs: `email` for a person, `common_name` for a
 * service token.
 *
 * Enabled only when ACCESS_AUD is set, so `wrangler dev` runs without it.
 *
 * No library: the token is RS256, the JWKS is public, and WebCrypto can
 * verify it. The JWKS is cached per isolate (one subrequest per isolate
 * lifetime, not per request).
 */

export interface Caller {
  /** email for a user, service-token name for a token */
  id: string;
  kind: "user" | "service";
}

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }

let jwksCache: { fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export async function verifyAccess(request: Request, env: Env): Promise<Caller | null> {
  if (!env.ACCESS_AUD) return null; // disabled (local dev)

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AccessError("missing Access token");

  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new AccessError("malformed token");

  const header = JSON.parse(b64urlToString(h)) as { alg: string; kid: string };
  if (header.alg !== "RS256") throw new AccessError(`unexpected alg ${header.alg}`);

  const key = await getKey(env.ACCESS_TEAM, header.kid);
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new AccessError("bad signature");

  const claims = JSON.parse(b64urlToString(p)) as {
    aud: string | string[]; iss: string; exp: number; nbf?: number; email?: string; common_name?: string;
  };
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AccessError("aud mismatch");
  if (claims.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) throw new AccessError("iss mismatch");
  if (claims.exp <= now) throw new AccessError("token expired");
  if (claims.nbf && claims.nbf > now + 60) throw new AccessError("token not yet valid");

  if (claims.email) return { id: claims.email, kind: "user" };
  if (claims.common_name) return { id: claims.common_name, kind: "service" };
  throw new AccessError("no identity in token");
}

export class AccessError extends Error {}

async function getKey(team: string, kid: string): Promise<CryptoKey> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (!fresh || !jwksCache!.keys.has(kid)) {
    // Unknown kid also triggers a refetch: Access rotates its signing keys.
    const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!res.ok) throw new AccessError(`jwks fetch ${res.status}`);
    const { keys } = (await res.json()) as { keys: Jwk[] };
    const map = new Map<string, CryptoKey>();
    for (const k of keys) {
      map.set(k.kid, await crypto.subtle.importKey(
        "jwk", { kty: k.kty, n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
      ));
    }
    jwksCache = { fetchedAt: Date.now(), keys: map };
  }
  const key = jwksCache!.keys.get(kid);
  if (!key) throw new AccessError(`unknown kid ${kid}`);
  return key;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}
