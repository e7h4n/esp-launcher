// esp-launcher hub: Cloudflare Worker + Durable Objects. Contract: docs/protocol.md
import { DurableObject } from "cloudflare:workers";
import { verifyAccessJwt } from "./access.js";
import { verifyClerkJwt, clerkFrontendApi, newToken, tokenHash, bearer, DEVICE_TOKEN_PREFIX, DEV_KEY_PREFIX } from "./auth.js";
import SETUP_HTML from "./setup.html";
import DASHBOARD_HTML from "./dashboard.html";

const RETENTION_MS = 7 * 24 * 3600 * 1000;
const RETENTION_ITEMS = 200000;
const IMAGE_CHUNK = 512 * 1024;
const READ_OPS = new Set(["status", "cmd.list", "param.list", "param.get", "coredump"]);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (status, message) => json({ error: message }, status);

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- auth

async function authenticate(request, env, kind) {
  if (env.DEV_INSECURE === "1") {
    if (kind === "device") {
      const cid = request.headers.get("X-Dev-Client-Id");
      return cid ? { type: "service", clientId: cid } : null;
    }
    return { type: "user", email: "dev@localhost" };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const aud = kind === "device" ? env.DEVICE_AUD : env.OPS_AUD;
  if (!token || !aud) return null;
  const claims = await verifyAccessJwt(token, env.ACCESS_TEAM, aud);
  if (!claims) return null;
  if (claims.common_name) return { type: "service", clientId: claims.common_name };
  if (claims.email) return { type: "user", email: claims.email };
  return null;
}

function registry(env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}
function deviceStub(env, id) {
  return env.DEVICE.get(env.DEVICE.idFromName(id));
}

// ---------------------------------------------------------------- worker

// Developers sign in with Clerk (browser) or use a developer secret (okl_key_..., API/Okou).
// Devices use their device token (okl_dev_...). No Cloudflare Access on these paths.
async function authUser(request, env, url) {
  if (env.DEV_INSECURE === "1" && request.headers.get("X-Dev-User")) {
    return { userId: request.headers.get("X-Dev-User"), via: "session" }; // local tests only
  }
  const t = bearer(request);
  if (!t) return null;
  if (t.startsWith(DEV_KEY_PREFIX)) {
    const k = await (await registry(env).fetch(`https://r/key-by-hash/${await tokenHash(t)}`)).json();
    return k.owner ? { userId: k.owner, via: "key", keyId: k.id } : null;
  }
  if (!env.CLERK_PUBLISHABLE_KEY) return null;
  const c = await verifyClerkJwt(t, env.CLERK_PUBLISHABLE_KEY, [url.origin]);
  return c ? { userId: c.userId, via: "session" } : null;
}

function page(html, env) {
  const pk = env.CLERK_PUBLISHABLE_KEY || "";
  const fapi = clerkFrontendApi(pk) || "";
  const body = html.replaceAll("__CLERK_PUBLISHABLE_KEY__", pk).replaceAll("__CLERK_FAPI__", fapi);
  const src = fapi ? `https://${fapi}` : "";
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'self'; script-src 'self' 'unsafe-inline' ${src} https://challenges.cloudflare.com; ` +
        `connect-src 'self' ${src} https://clerk-telemetry.com; img-src 'self' data: https://img.clerk.com; ` +
        `style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:`,
    },
  });
}

async function apiRoute(request, env, url, parts) {
  // parts: ["api", ...]
  if (parts[1] === "device") {
    // device side: bearer device token
    const t = bearer(request);
    if (!t || !t.startsWith(DEVICE_TOKEN_PREFIX)) return err(401, "device token required");
    const dev = await (await registry(env).fetch(`https://r/by-token/${await tokenHash(t)}`)).json();
    if (!dev.id) return err(401, "unknown device token");
    const rest = "/" + parts.slice(2).join("/");
    const fwd = new Request(`https://d/device${rest}${url.search}`, request);
    fwd.headers.set("X-Device-Id", dev.id);
    return deviceStub(env, dev.id).fetch(fwd);
  }
  if (parts[1] === "config" && parts.length === 2) {
    return json({ clerk_publishable_key: env.CLERK_PUBLISHABLE_KEY || null, hub: url.host });
  }
  const who = await authUser(request, env, url);
  if (!who) return err(401, "sign in, or pass a developer secret as Authorization: Bearer okl_key_...");
  const reg = registry(env);
  const owner = encodeURIComponent(who.userId);

  if (parts[1] === "me" && parts.length === 2) return json({ user_id: who.userId, via: who.via });

  if (parts[1] === "keys") {
    if (who.via !== "session") return err(403, "manage developer secrets from a signed-in session");
    if (parts.length === 2 && request.method === "GET") return reg.fetch(`https://r/keys?owner=${owner}`);
    if (parts.length === 2 && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const secret = newToken(DEV_KEY_PREFIX);
      const id = secret.slice(0, DEV_KEY_PREFIX.length + 6);
      const r = await reg.fetch(new Request("https://r/keys", {
        method: "POST",
        body: JSON.stringify({ id, owner: who.userId, hash: await tokenHash(secret), label: String(b.label || "").slice(0, 60) }),
      }));
      if (!r.ok) return r;
      return json({ id, secret, label: b.label || "", note: "shown once; keep it with you, never on a device" });
    }
    if (parts.length === 3 && request.method === "DELETE") {
      return reg.fetch(new Request(`https://r/keys/${encodeURIComponent(parts[2])}?owner=${owner}`, { method: "DELETE" }));
    }
    return err(404, "not found");
  }

  if (parts[1] !== "devices") return err(404, "not found");
  const id = parts[2];
  if (!id) {
    if (request.method === "GET") {
      const list = await (await reg.fetch(`https://r/list?owner=${owner}`)).json();
      const devices = await Promise.all(
        list.devices.map(async (d) => {
          const s = await (await deviceStub(env, d.id).fetch("https://d/ops/summary")).json();
          const { token_hash, client_id, token_uuid, ...pub } = d;
          return { ...pub, ...s };
        }),
      );
      return json({ devices });
    }
    if (request.method === "POST") {
      // add a device: returns its device token once (written to the device by the setup page)
      const b = await request.json().catch(() => ({}));
      const did = String(b.device_id || "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(did)) return err(400, "device_id: lowercase letters, digits and dashes");
      const token = newToken(DEVICE_TOKEN_PREFIX);
      const r = await reg.fetch(new Request(`https://r/devices/${did}/token`, {
        method: "POST",
        body: JSON.stringify({ owner: who.userId, label: String(b.label || did).slice(0, 60), token_hash: await tokenHash(token), rotate: !!b.rotate }),
      }));
      if (!r.ok) return r;
      const out = await r.json();
      return json({ device_id: did, hub: url.host, token, rotated: !!out.rotated, note: "shown once; the setup page writes it to the device" });
    }
    return err(405, "method not allowed");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return err(400, "invalid device id");
  const entry = await (await reg.fetch(`https://r/devices/${id}`)).json();
  if (!entry.id || entry.owner !== who.userId) return err(404, "unknown device");
  if (parts.length === 3 && request.method === "DELETE") {
    await reg.fetch(new Request(`https://r/devices/${id}`, { method: "DELETE" }));
    return json({ id, deleted: true });
  }
  const rest = "/" + parts.slice(3).join("/");
  const fwd = new Request(`https://d/ops${rest === "/" ? "" : rest}${url.search}`, request);
  fwd.headers.set("X-Device-Id", id);
  fwd.headers.set("X-Caller-Type", who.via === "session" ? "user" : "service");
  fwd.headers.set("X-Writes-Require-Human", entry.writes_require_human ? "1" : "0");
  fwd.headers.set("X-Hub-Origin", url.origin);
  fwd.headers.set("X-Image-Path", entry.token_hash ? "/api/device/images" : "/device/images");
  return deviceStub(env, id).fetch(fwd);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "api") return apiRoute(request, env, url, parts);
    if (url.pathname === "/" || url.pathname === "/devices") return page(DASHBOARD_HTML, env);
    if (url.pathname === "/setup") return page(SETUP_HTML.replace("__HUB_MODE__", "clerk"), env);

    if (parts[0] === "device") {
      const who = await authenticate(request, env, "device");
      if (!who || who.type !== "service") return err(403, "device authentication required");
      const dev = await (await registry(env).fetch(`https://r/by-client/${encodeURIComponent(who.clientId)}`)).json();
      if (!dev.id) return err(403, "unregistered device token");
      const rest = "/" + parts.slice(1).join("/");
      const fwd = new Request(`https://d/device${rest}${url.search}`, request);
      fwd.headers.set("X-Device-Id", dev.id);
      return deviceStub(env, dev.id).fetch(fwd);
    }

    if (parts[0] === "ops") {
      const who = await authenticate(request, env, "ops");
      if (!who) return err(403, "operator authentication required");
      if (parts[1] === "setup" && parts.length === 2 && request.method === "GET") {
        return new Response(SETUP_HTML.replace("__HUB_MODE__", "access"), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
          },
        });
      }
      if (parts[1] === "enroll" && parts.length === 2 && request.method === "POST") {
        return enroll(request, env, url, who);
      }
      if (parts[1] === "whoami" && parts.length === 2) {
        return json({ type: who.type, email: who.email || null, client_id: who.clientId || null });
      }
      if (parts[1] !== "devices") return err(404, "not found");
      const id = parts[2];
      if (!id) {
        if (request.method !== "GET") return err(405, "method not allowed");
        const list = await (await registry(env).fetch("https://r/list")).json();
        const devices = await Promise.all(
          list.devices.map(async (d) => {
            const s = await (await deviceStub(env, d.id).fetch("https://d/ops/summary")).json();
            return { ...d, ...s };
          }),
        );
        return json({ devices });
      }
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return err(400, "invalid device id");
      if (parts.length === 3 && request.method === "DELETE") {
        const entry = await (await registry(env).fetch(`https://r/devices/${id}`)).json();
        let revoked = false;
        if (entry.token_uuid && env.CF_ENROLL_TOKEN) {
          revoked = (await cfApi(env, "DELETE", `/access/service_tokens/${entry.token_uuid}`)).ok;
        }
        await registry(env).fetch(new Request(`https://r/devices/${id}`, { method: "DELETE" }));
        return json({ id, deleted: !!entry.id, token_revoked: revoked });
      }
      if (parts.length === 3 && request.method === "PUT") {
        return registry(env).fetch(new Request(`https://r/devices/${id}`, request));
      }
      if (parts.length === 4 && parts[3] === "owner" && request.method === "POST") {
        // migration: assign an existing (Access-enrolled) device to a Clerk user
        return registry(env).fetch(new Request(`https://r/devices/${id}/owner`, request));
      }
      const entry = await (await registry(env).fetch(`https://r/devices/${id}`)).json();
      if (!entry.id) return err(404, "unknown device");
      const rest = "/" + parts.slice(3).join("/");
      const fwd = new Request(`https://d/ops${rest === "/" ? "" : rest}${url.search}`, request);
      fwd.headers.set("X-Device-Id", id);
      fwd.headers.set("X-Caller-Type", who.type);
      fwd.headers.set("X-Writes-Require-Human", entry.writes_require_human ? "1" : "0");
      fwd.headers.set("X-Hub-Origin", url.origin);
      return deviceStub(env, id).fetch(fwd);
    }

    return err(404, "not found");
  },
};

// ---------------------------------------------------------------- enrollment
// The hub creates one Cloudflare Access service token per device (CF_ENROLL_TOKEN only has
// "Access: Service Tokens Edit"), registers the device, and returns the credentials once so the
// setup page can hand them to the device over BLE. The device Access app admits any valid service
// token of the account; the registry below decides which ones are devices.

async function cfApi(env, method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_ENROLL_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success, status: r.status, result: j.result, errors: j.errors };
}

async function enroll(request, env, url, who) {
  if (!env.CF_ENROLL_TOKEN || !env.ACCOUNT_ID) return err(503, "enrollment is not configured on this hub");
  let b;
  try {
    b = await request.json();
  } catch {
    return err(400, "invalid json");
  }
  const id = String(b.device_id || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return err(400, "device_id: lowercase letters, digits and dashes");
  const reg = registry(env);
  const existing = await (await reg.fetch(`https://r/devices/${id}`)).json();
  if (existing.id && !b.rotate) return err(409, `device ${id} already exists; pass rotate:true to issue a new token`);
  const created = await cfApi(env, "POST", "/access/service_tokens", { name: `esp-dev-${id}`, duration: "8760h" });
  if (!created.ok) return err(502, `creating the service token failed: ${JSON.stringify(created.errors)}`);
  const t = created.result;
  const put = await reg.fetch(
    new Request(`https://r/devices/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        client_id: t.client_id,
        label: b.label || existing.label || id,
        token_expires_at: t.expires_at || null,
        token_uuid: t.id,
        writes_require_human: !!(b.writes_require_human ?? existing.writes_require_human),
        enrolled_by: who.email || who.clientId || null,
      }),
    }),
  );
  if (!put.ok) {
    await cfApi(env, "DELETE", `/access/service_tokens/${t.id}`);
    return err(500, `registering the device failed: ${await put.text()}`);
  }
  if (existing.token_uuid) await cfApi(env, "DELETE", `/access/service_tokens/${existing.token_uuid}`);
  return json({
    device_id: id,
    hub: url.host,
    token: { id: t.client_id, secret: t.client_secret },
    token_expires_at: t.expires_at || null,
    rotated: !!existing.id,
  });
}

// ---------------------------------------------------------------- registry

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, client_id TEXT UNIQUE NOT NULL, label TEXT,
      token_expires_at TEXT, writes_require_human INTEGER DEFAULT 0, created_at INTEGER)`);
    const cols = this.sql.exec("PRAGMA table_info(devices)").toArray().map((c) => c.name);
    if (!cols.includes("token_uuid")) this.sql.exec("ALTER TABLE devices ADD COLUMN token_uuid TEXT");
    if (!cols.includes("enrolled_by")) this.sql.exec("ALTER TABLE devices ADD COLUMN enrolled_by TEXT");
    if (!cols.includes("owner")) this.sql.exec("ALTER TABLE devices ADD COLUMN owner TEXT");
    if (!cols.includes("token_hash")) this.sql.exec("ALTER TABLE devices ADD COLUMN token_hash TEXT");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS devices_token_hash ON devices(token_hash) WHERE token_hash IS NOT NULL");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS keys (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, label TEXT,
      created_at INTEGER, last_used_at INTEGER)`);
  }
  row(r) {
    return r && { ...r, writes_require_human: !!r.writes_require_human };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname.split("/").filter(Boolean);
    if (p[0] === "list") {
      const owner = url.searchParams.get("owner");
      const rows = owner
        ? this.sql.exec("SELECT * FROM devices WHERE owner = ? ORDER BY id", owner).toArray()
        : this.sql.exec("SELECT * FROM devices ORDER BY id").toArray();
      return json({ devices: rows.map((r) => this.row(r)) });
    }
    if (p[0] === "by-token") {
      return json(this.row(this.sql.exec("SELECT * FROM devices WHERE token_hash = ?", p[1]).toArray()[0]) || {});
    }
    if (p[0] === "key-by-hash") {
      const k = this.sql.exec("SELECT id, owner FROM keys WHERE hash = ?", p[1]).toArray()[0];
      if (k) this.sql.exec("UPDATE keys SET last_used_at = ? WHERE id = ?", Date.now(), k.id);
      return json(k || {});
    }
    if (p[0] === "keys") {
      if (!p[1] && request.method === "GET") {
        const owner = url.searchParams.get("owner");
        return json({ keys: this.sql.exec("SELECT id, label, created_at, last_used_at FROM keys WHERE owner = ? ORDER BY created_at", owner).toArray() });
      }
      if (!p[1] && request.method === "POST") {
        const b = await request.json();
        const n = this.sql.exec("SELECT COUNT(*) AS n FROM keys WHERE owner = ?", b.owner).one().n;
        if (n >= 10) return err(409, "at most 10 developer secrets per account");
        this.sql.exec("INSERT INTO keys (id, owner, hash, label, created_at) VALUES (?, ?, ?, ?, ?)", b.id, b.owner, b.hash, b.label || "", Date.now());
        return json({ id: b.id });
      }
      if (p[1] && request.method === "DELETE") {
        this.sql.exec("DELETE FROM keys WHERE id = ? AND owner = ?", decodeURIComponent(p[1]), url.searchParams.get("owner"));
        return json({ deleted: true });
      }
    }
    if (p[0] === "by-client") {
      const r = this.sql.exec("SELECT * FROM devices WHERE client_id = ?", decodeURIComponent(p[1])).toArray()[0];
      return json(this.row(r) || {});
    }
    if (p[0] === "devices") {
      const id = p[1];
      if (p[2] === "token" && request.method === "POST") {
        const b = await request.json();
        const cur = this.sql.exec("SELECT * FROM devices WHERE id = ?", id).toArray()[0];
        if (cur && cur.owner !== b.owner) return err(409, `device id ${id} is taken`);
        if (cur && !b.rotate) return err(409, `device ${id} already exists; pass rotate:true to issue a new token`);
        if (!cur) {
          const n = this.sql.exec("SELECT COUNT(*) AS n FROM devices WHERE owner = ?", b.owner).one().n;
          if (n >= 50) return err(409, "at most 50 devices per account");
          this.sql.exec(
            "INSERT INTO devices (id, client_id, label, writes_require_human, created_at, owner, token_hash) VALUES (?, ?, ?, 0, ?, ?, ?)",
            id, `token:${id}`, b.label || id, Date.now(), b.owner, b.token_hash,
          );
        } else {
          this.sql.exec("UPDATE devices SET token_hash = ?, label = ? WHERE id = ?", b.token_hash, b.label || cur.label, id);
        }
        return json({ id, rotated: !!cur });
      }
      if (p[2] === "owner" && request.method === "POST") {
        const b = await request.json();
        const cur = this.sql.exec("SELECT id FROM devices WHERE id = ?", id).toArray()[0];
        if (!cur) return err(404, "unknown device");
        this.sql.exec("UPDATE devices SET owner = ? WHERE id = ?", b.owner || null, id);
        return json({ id, owner: b.owner || null });
      }
      if (request.method === "GET") {
        return json(this.row(this.sql.exec("SELECT * FROM devices WHERE id = ?", id).toArray()[0]) || {});
      }
      if (request.method === "DELETE") {
        this.sql.exec("DELETE FROM devices WHERE id = ?", id);
        return json({});
      }
      if (request.method === "PUT") {
        let b;
        try {
          b = await request.json();
        } catch {
          return err(400, "invalid json");
        }
        if (!b.client_id || typeof b.client_id !== "string") return err(400, "client_id required");
        const clash = this.sql.exec("SELECT id FROM devices WHERE client_id = ? AND id != ?", b.client_id, id).toArray()[0];
        if (clash) return err(409, `client_id already bound to ${clash.id}`);
        this.sql.exec(
          `INSERT INTO devices (id, client_id, label, token_expires_at, writes_require_human, created_at, token_uuid, enrolled_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, label = excluded.label,
             token_expires_at = excluded.token_expires_at, writes_require_human = excluded.writes_require_human,
             token_uuid = excluded.token_uuid, enrolled_by = excluded.enrolled_by`,
          id, b.client_id, b.label || id, b.token_expires_at || null, b.writes_require_human ? 1 : 0, Date.now(),
          b.token_uuid || null, b.enrolled_by || null,
        );
        return json(this.row(this.sql.exec("SELECT * FROM devices WHERE id = ?", id).toArray()[0]));
      }
    }
    return err(404, "not found");
  }
}

// ---------------------------------------------------------------- device hub

export class DeviceHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, recv_at INTEGER NOT NULL,
      boot_id TEXT, data TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS images (sha TEXT, idx INTEGER, data BLOB, PRIMARY KEY (sha, idx))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS image_meta (sha TEXT PRIMARY KEY, size INTEGER, created_at INTEGER)`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.pending = new Map(); // rpc id -> {resolve, timer}
    this.waiters = new Set(); // long-poll resolvers
    this.inserts = 0;
  }

  // ---- small helpers
  kvGet(k) {
    const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return r ? JSON.parse(r.v) : null;
  }
  kvSet(k, v) {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }
  deviceSocket() {
    return this.ctx.getWebSockets("device")[0] || null;
  }
  addItem(kind, data, bootId) {
    const now = Date.now();
    const seq = this.sql
      .exec("INSERT INTO items (kind, recv_at, boot_id, data) VALUES (?, ?, ?, ?) RETURNING seq", kind, now, bootId || null, JSON.stringify(data))
      .one().seq;
    const item = { seq, kind, recv_at: now, boot_id: bootId || null, data };
    for (const ws of this.ctx.getWebSockets("ops")) {
      try {
        ws.send(JSON.stringify(item));
      } catch {}
    }
    for (const w of this.waiters) w();
    if (++this.inserts % 500 === 0) this.prune();
    return item;
  }
  prune() {
    this.sql.exec("DELETE FROM items WHERE recv_at < ?", Date.now() - RETENTION_MS);
    const max = this.sql.exec("SELECT MAX(seq) AS m FROM items").one().m || 0;
    this.sql.exec("DELETE FROM items WHERE seq <= ?", max - RETENTION_ITEMS);
  }
  summary() {
    const ws = this.deviceSocket();
    const hello = this.kvGet("hello");
    let lastSeen = this.kvGet("last_seen");
    if (ws) {
      const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      lastSeen = Math.max(lastSeen || 0, ts ? ts.getTime() : 0, this.kvGet("last_msg") || 0,
        this.kvGet("connected_at") || 0);
    }
    // A socket whose peer vanished without a close frame can linger; devices ping every 30 s,
    // so treat >90 s of silence as offline (and drop the stale socket).
    const fresh = !!ws && !!lastSeen && Date.now() - lastSeen < 90_000;
    if (ws && !fresh && lastSeen) {
      try {
        ws.close(4001, "stale: no ping for 90 s");
      } catch {}
    }
    return {
      online: fresh,
      role: hello?.role ?? null,
      fw: hello?.fw ?? null,
      partition: hello?.partition ?? null,
      connected_at: this.kvGet("connected_at"),
      last_seen: lastSeen || null,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname.split("/").filter(Boolean);
    if (p[0] === "device") return this.deviceRoute(request, p.slice(1));
    if (p[0] === "ops") return this.opsRoute(request, url, p.slice(1));
    return err(404, "not found");
  }

  // ---- device side
  async deviceRoute(request, p) {
    if (p[0] === "connect") {
      if (request.headers.get("Upgrade") !== "websocket") return err(426, "websocket required");
      for (const old of this.ctx.getWebSockets("device")) {
        try {
          old.close(4000, "replaced by new connection");
        } catch {}
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["device"]);
      this.kvSet("connected_at", Date.now());
      this.addItem("conn", { state: "connected" }, null);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (p[0] === "images" && p[1] && request.method === "GET") {
      return this.serveImage(p[1]);
    }
    return err(404, "not found");
  }

  serveImage(sha) {
    const meta = this.sql.exec("SELECT size FROM image_meta WHERE sha = ?", sha).toArray()[0];
    if (!meta) return err(404, "image not staged");
    const chunks = this.sql.exec("SELECT data FROM images WHERE sha = ? ORDER BY idx", sha).toArray();
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c.data));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/octet-stream", "content-length": String(meta.size) },
    });
  }

  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    if (!tags.includes("device")) return; // ops sockets are receive-only
    if (typeof message !== "string") return;
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    this.kvSet("last_msg", Date.now());
    switch (m.t) {
      case "hello": {
        this.kvSet("hello", m);
        this.kvSet("boot_id", m.boot_id || null);
        const stored = this.kvGet(`logseq:${m.boot_id}`) || 0;
        this.addItem("hello", m, m.boot_id);
        ws.send(JSON.stringify({ t: "ack", seq: stored }));
        break;
      }
      case "log": {
        const bootId = this.kvGet("boot_id");
        const key = `logseq:${bootId}`;
        const stored = this.kvGet(key) || 0;
        const seq0 = Number(m.seq) || 0;
        const lines = Array.isArray(m.lines) ? m.lines : [];
        const fresh = lines.filter((_, i) => seq0 + i > stored);
        const last = Math.max(stored, seq0 + lines.length - 1);
        if (fresh.length) this.addItem("log", { seq: seq0 + lines.length - fresh.length, lines: fresh }, bootId);
        this.kvSet(key, last);
        ws.send(JSON.stringify({ t: "ack", seq: last }));
        break;
      }
      case "metric":
        this.addItem("metric", { items: m.items || [] }, this.kvGet("boot_id"));
        break;
      case "event":
        this.addItem("event", { name: m.name, data: m.data ?? null }, this.kvGet("boot_id"));
        break;
      case "res": {
        const p = this.pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          p.resolve(m.ok ? { ok: true, data: m.data ?? {} } : { ok: false, error: m.error || "error" });
        }
        break;
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    if (this.ctx.getTags(ws).includes("device")) this.deviceGone(code, reason);
    try {
      ws.close(code, reason);
    } catch {}
  }
  async webSocketError(ws) {
    if (this.ctx.getTags(ws).includes("device")) this.deviceGone(1006, "error");
  }
  deviceGone(code, reason) {
    this.kvSet("last_seen", Date.now());
    this.addItem("conn", { state: "disconnected", code, reason: String(reason || "") }, null);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: "device disconnected" });
      this.pending.delete(id);
    }
  }

  rpc(op, args, timeoutMs) {
    const ws = this.deviceSocket();
    if (!ws) return Promise.resolve(null);
    const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `timeout after ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        ws.send(JSON.stringify({ t: "req", id, op, args: args || {} }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `send failed: ${e.message}` });
      }
    });
  }

  // ---- operator side
  async opsRoute(request, url, p) {
    const humanOnly = request.headers.get("X-Writes-Require-Human") === "1";
    const caller = request.headers.get("X-Caller-Type");
    const writeBlocked = humanOnly && caller !== "user";
    const route = p.join("/");

    if (route === "summary") return json(this.summary());
    if (route === "" && request.method === "GET") {
      return json({ id: request.headers.get("X-Device-Id"), ...this.summary(), hello: this.kvGet("hello") });
    }

    if (route === "stream" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") || 0);
      const limit = Math.min(Number(url.searchParams.get("limit") || 500), 2000);
      const wait = Math.min(Number(url.searchParams.get("wait") || 0), 25);
      const kinds = (url.searchParams.get("kinds") || "").split(",").filter(Boolean);
      const query = () => {
        const q = kinds.length
          ? this.sql.exec(
              `SELECT * FROM items WHERE seq > ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY seq LIMIT ?`,
              after, ...kinds, limit,
            )
          : this.sql.exec("SELECT * FROM items WHERE seq > ? ORDER BY seq LIMIT ?", after, limit);
        return q.toArray().map((r) => ({ ...r, data: JSON.parse(r.data) }));
      };
      let items = query();
      if (!items.length && wait > 0) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            this.waiters.delete(check);
            clearTimeout(timer);
            resolve();
          };
          const check = () => {
            if (query().length) finish();
          };
          const timer = setTimeout(finish, wait * 1000);
          this.waiters.add(check);
        });
        items = query();
      }
      const maxSeq = this.sql.exec("SELECT MAX(seq) AS m FROM items").one().m || 0;
      const next = items.length ? items[items.length - 1].seq : Math.max(after, kinds.length ? maxSeq : after);
      return json({ items, next, online: !!this.deviceSocket() });
    }

    if (route === "tail") {
      if (request.headers.get("Upgrade") !== "websocket") return err(426, "websocket required");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["ops"]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (route === "rpc" && request.method === "POST") {
      let b;
      try {
        b = await request.json();
      } catch {
        return err(400, "invalid json");
      }
      if (!b.op) return err(400, "op required");
      if (writeBlocked && !READ_OPS.has(b.op)) return err(403, "this device requires a human operator for writes");
      if (b.op === "install") return err(400, "use POST /install");
      const timeout = Math.min(Math.max(Number(b.timeout_ms) || 10000, 500), 60000);
      const r = await this.rpc(b.op, b.args, timeout);
      if (!r) return err(409, "device offline");
      return json(r);
    }

    if (p[0] === "images" && p[1] && request.method === "PUT") {
      if (writeBlocked) return err(403, "this device requires a human operator for writes");
      const buf = await request.arrayBuffer();
      return this.stageImage(p[1].toLowerCase(), buf);
    }
    if (p[0] === "images" && !p[1] && request.method === "GET") {
      return json({ images: this.sql.exec("SELECT * FROM image_meta ORDER BY created_at DESC").toArray() });
    }

    if (route === "install" && request.method === "POST") {
      if (writeBlocked) return err(403, "this device requires a human operator for writes");
      let b;
      try {
        b = await request.json();
      } catch {
        return err(400, "invalid json");
      }
      const kind = b.kind || "app";
      if (!["app", "launcher"].includes(kind)) return err(400, "kind must be app or launcher");
      // No application-layer signing: integrity is the SHA-256 over HTTPS. Older launchers still
      // verify a signature, so it is passed through when given.
      let sha = (b.sha256 || "").toLowerCase();
      if (b.url) {
        const r = await fetch(b.url, { redirect: "follow" });
        if (!r.ok) return err(502, `fetch ${b.url} failed: HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        const got = await sha256Hex(buf);
        if (sha && got !== sha) return err(400, `sha256 mismatch: expected ${sha}, got ${got}`);
        sha = got;
        const staged = await this.stageImage(sha, buf);
        if (staged.status !== 200) return staged;
      }
      const meta = this.sql.exec("SELECT size FROM image_meta WHERE sha = ?", sha).toArray()[0];
      if (!meta) return err(404, "image not staged; PUT /images/<sha256> first or pass url");
      const origin = request.headers.get("X-Hub-Origin");
      const args = {
        kind,
        url: `${origin}${request.headers.get("X-Image-Path") || "/device/images"}/${sha}`,
        size: meta.size,
        sha256: sha,
        sig: b.sig || "",
        name: b.name || "",
        version: b.version || "",
      };
      const r = await this.rpc("install", args, 15000);
      if (!r) return err(409, "device offline");
      return json(r);
    }

    return err(404, "not found");
  }

  async stageImage(sha, buf) {
    if (!/^[0-9a-f]{64}$/.test(sha)) return err(400, "sha256 must be 64 hex chars");
    if (buf.byteLength === 0 || buf.byteLength > 8 * 1024 * 1024) return err(400, "image size must be 1 B .. 8 MiB");
    const got = await sha256Hex(buf);
    if (got !== sha) return err(400, `sha256 mismatch: expected ${sha}, got ${got}`);
    // keep at most 3 images per device
    const old = this.sql.exec("SELECT sha FROM image_meta WHERE sha != ? ORDER BY created_at DESC", sha).toArray().slice(2);
    for (const o of old) {
      this.sql.exec("DELETE FROM images WHERE sha = ?", o.sha);
      this.sql.exec("DELETE FROM image_meta WHERE sha = ?", o.sha);
    }
    this.sql.exec("DELETE FROM images WHERE sha = ?", sha);
    const bytes = new Uint8Array(buf);
    for (let i = 0, idx = 0; i < bytes.length; i += IMAGE_CHUNK, idx++) {
      this.sql.exec("INSERT INTO images (sha, idx, data) VALUES (?, ?, ?)", sha, idx, bytes.slice(i, i + IMAGE_CHUNK));
    }
    this.sql.exec(
      "INSERT INTO image_meta (sha, size, created_at) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET size = excluded.size, created_at = excluded.created_at",
      sha, bytes.length, Date.now(),
    );
    return json({ sha256: sha, size: bytes.length });
  }
}
