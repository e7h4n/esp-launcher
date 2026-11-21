// Cloudflare Access JWT verification (RS256, keys from <team>/cdn-cgi/access/certs).
let cache = { team: null, keys: null, at: 0 };

async function keys(team) {
  if (cache.team === team && cache.keys && Date.now() - cache.at < 3600_000) return cache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certs fetch failed: ${r.status}`);
  const body = await r.json();
  const map = new Map();
  for (const jwk of body.keys || []) {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    map.set(jwk.kid, key);
  }
  cache = { team, keys: map, at: Date.now() };
  return map;
}

function b64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function verifyAccessJwt(token, team, aud) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  let k = (await keys(team)).get(header.kid);
  if (!k) {
    cache.at = 0; // key rotation: refetch once
    k = (await keys(team)).get(header.kid);
    if (!k) return null;
  }
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    k,
    b64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
  if (claims.iss !== `https://${team}`) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  return claims;
}
