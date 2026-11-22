// Clerk session JWTs (RS256, JWKS from the instance's Frontend API) and hub-issued tokens.
// Transport security is HTTPS; tokens are random bearer strings stored only as SHA-256 hashes.

let jwks = { url: null, keys: null, at: 0 };

function b64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// pk_test_<base64("<frontend-api-host>$")> -> "<frontend-api-host>"
export function clerkFrontendApi(publishableKey) {
  const m = /^pk_(test|live)_(.+)$/.exec(publishableKey || "");
  if (!m) return null;
  try {
    const host = atob(m[2]).replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

async function keys(url) {
  if (jwks.url === url && jwks.keys && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`jwks fetch failed: ${r.status}`);
  const map = new Map();
  for (const jwk of (await r.json()).keys || []) {
    if (jwk.kty !== "RSA") continue;
    map.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  jwks = { url, keys: map, at: Date.now() };
  return map;
}

// Returns { userId, sessionId } or null. `origins`: accepted `azp` values (the hub's own origin).
export async function verifyClerkJwt(token, publishableKey, origins) {
  const fapi = clerkFrontendApi(publishableKey);
  const parts = (token || "").split(".");
  if (!fapi || parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const url = `https://${fapi}/.well-known/jwks.json`;
  let k = (await keys(url)).get(header.kid);
  if (!k) {
    jwks.at = 0; // key rotation: refetch once
    k = (await keys(url)).get(header.kid);
    if (!k) return null;
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - 30) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) return null;
  if (claims.iss !== `https://${fapi}`) return null;
  if (claims.azp && origins && !origins.includes(claims.azp)) return null;
  if (!claims.sub) return null;
  return { userId: claims.sub, sessionId: claims.sid || null };
}

// ---- hub-issued bearer tokens
export const DEVICE_TOKEN_PREFIX = "okl_dev_"; // on the device: pull only (connect, logs, downloads)
export const DEV_KEY_PREFIX = "okl_key_"; // developer secret: push (firmware, scripts, exec, commands)

export function newToken(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(32));
  const s = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return prefix + s;
}

export async function tokenHash(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}
