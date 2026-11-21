// esp-launcher hub: Cloudflare Worker + Durable Objects. Contract: docs/protocol.md
import { DurableObject } from "cloudflare:workers";
import { verifyAccessJwt } from "./access.js";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

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
      if (parts.length === 3 && (request.method === "PUT" || request.method === "DELETE")) {
        return registry(env).fetch(new Request(`https://r/devices/${id}`, request));
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

    if (url.pathname === "/") return new Response("esp-launcher hub\n");
    return err(404, "not found");
  },
};

// ---------------------------------------------------------------- registry

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, client_id TEXT UNIQUE NOT NULL, label TEXT,
      token_expires_at TEXT, writes_require_human INTEGER DEFAULT 0, created_at INTEGER)`);
  }
  row(r) {
    return r && { ...r, writes_require_human: !!r.writes_require_human };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname.split("/").filter(Boolean);
    if (p[0] === "list") {
      return json({ devices: this.sql.exec("SELECT * FROM devices ORDER BY id").toArray().map((r) => this.row(r)) });
    }
    if (p[0] === "by-client") {
      const r = this.sql.exec("SELECT * FROM devices WHERE client_id = ?", decodeURIComponent(p[1])).toArray()[0];
      return json(this.row(r) || {});
    }
    if (p[0] === "devices") {
      const id = p[1];
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
          `INSERT INTO devices (id, client_id, label, token_expires_at, writes_require_human, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, label = excluded.label,
             token_expires_at = excluded.token_expires_at, writes_require_human = excluded.writes_require_human`,
          id, b.client_id, b.label || id, b.token_expires_at || null, b.writes_require_human ? 1 : 0, Date.now(),
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
      lastSeen = Math.max(lastSeen || 0, ts ? ts.getTime() : 0, this.kvGet("last_msg") || 0);
    }
    return {
      online: !!ws,
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
      if (!b.sig) return err(400, "sig required");
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
        url: `${origin}/device/images/${sha}`,
        size: meta.size,
        sha256: sha,
        sig: b.sig,
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
