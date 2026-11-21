#!/usr/bin/env python3
"""Minimal esp-launcher hub mock (docs/protocol.md v1 subset) for QEMU / CI tests.

Python stdlib only. Implements:
  device:   GET /device/connect (WebSocket, X-Dev-Client-Id auth), GET /device/images/<sha>
  operator: GET/PUT/DELETE /ops/devices[/<id>], GET .../stream, POST .../rpc,
            PUT .../images/<sha>, POST .../install
No Cloudflare Access: this is the DEV_INSECURE=1 behaviour only.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import struct
import sys
import time
import urllib.parse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 16 * 1024


def now_ms():
    return int(time.time() * 1000)


class Device:
    def __init__(self, dev_id, client_id, label):
        self.id = dev_id
        self.client_id = client_id
        self.label = label
        self.items = []
        self.seq = 0
        self.ws = None
        self.hello = None
        self.boot_id = None
        self.stored_log_seq = {}  # boot_id -> highest stored line seq
        self.pending = {}
        self.images = {}
        self.connected_at = None
        self.last_seen = None
        self.last_ack = None
        self.cond = asyncio.Condition()

    def public(self):
        return {"id": self.id, "label": self.label, "online": self.ws is not None,
                "role": (self.hello or {}).get("role"), "fw": (self.hello or {}).get("fw"),
                "last_seen": self.last_seen, "token_expires_at": None}

    async def add(self, kind, data):
        async with self.cond:
            self.seq += 1
            self.items.append({"seq": self.seq, "kind": kind, "recv_at": now_ms(),
                               "boot_id": self.boot_id, "data": data})
            if len(self.items) > 200000:
                del self.items[:10000]
            self.cond.notify_all()


class Hub:
    def __init__(self, verbose=False):
        self.devices = {}
        self.req_counter = 0
        self.verbose = verbose

    def log(self, *a):
        if self.verbose:
            print("[hub]", *a, file=sys.stderr, flush=True)

    def by_client(self, cid):
        for d in self.devices.values():
            if d.client_id == cid:
                return d
        return None

    # ------------------------------------------------------------------ HTTP plumbing
    async def handle(self, reader, writer):
        try:
            line = await reader.readline()
            if not line:
                return
            method, target, _ = line.decode("latin1").split(" ", 2)
            headers = {}
            while True:
                h = await reader.readline()
                if h in (b"\r\n", b"\n", b""):
                    break
                k, _, v = h.decode("latin1").partition(":")
                headers[k.strip().lower()] = v.strip()
            body = b""
            n = int(headers.get("content-length", "0") or 0)
            if n:
                body = await reader.readexactly(n)
            url = urllib.parse.urlsplit(target)
            q = dict(urllib.parse.parse_qsl(url.query))
            path = url.path
            if path == "/device/connect" and headers.get("upgrade", "").lower() == "websocket":
                await self.device_ws(reader, writer, headers)
                return
            status, obj, raw = await self.route(method, path, q, headers, body)
            if raw is not None:
                hdr = (f"HTTP/1.1 {status} OK\r\nContent-Type: application/octet-stream\r\n"
                       f"Content-Length: {len(raw)}\r\nConnection: close\r\n\r\n")
                writer.write(hdr.encode())
                for i in range(0, len(raw), 16384):
                    writer.write(raw[i:i + 16384])
                    await writer.drain()
            else:
                data = json.dumps(obj).encode()
                hdr = (f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n"
                       f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n")
                writer.write(hdr.encode() + data)
            await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as e:  # keep the server alive
            self.log("handler error", repr(e))
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def route(self, method, path, q, headers, body):
        parts = [p for p in path.split("/") if p]
        if parts[:2] == ["device", "images"] and len(parts) == 3 and method == "GET":
            d = self.by_client(headers.get("x-dev-client-id", ""))
            if not d:
                return 401, {"error": "unknown device"}, None
            img = d.images.get(parts[2].lower())
            if img is None:
                return 404, {"error": "image not staged"}, None
            self.log(f"serving image {parts[2][:12]} ({len(img)} B) to {d.id}")
            return 200, None, img
        if parts[:2] != ["ops", "devices"]:
            return 404, {"error": "not found"}, None
        if len(parts) == 2 and method == "GET":
            return 200, {"devices": [d.public() for d in self.devices.values()]}, None
        if len(parts) < 3:
            return 404, {"error": "not found"}, None
        dev_id = parts[2]
        d = self.devices.get(dev_id)
        if len(parts) == 3:
            if method == "PUT":
                j = json.loads(body or b"{}")
                cid = j.get("client_id", dev_id)
                if d:
                    d.client_id, d.label = cid, j.get("label", d.label)
                else:
                    d = self.devices[dev_id] = Device(dev_id, cid, j.get("label", dev_id))
                return 200, {"id": dev_id, "client_id": cid, "label": d.label}, None
            if not d:
                return 404, {"error": "unknown device"}, None
            if method == "DELETE":
                del self.devices[dev_id]
                return 200, {}, None
            if method == "GET":
                return 200, {"id": d.id, "online": d.ws is not None, "hello": d.hello,
                             "connected_at": d.connected_at, "last_seen": d.last_seen,
                             "last_ack": d.last_ack}, None
        if not d:
            return 404, {"error": "unknown device"}, None
        sub = parts[3]
        if sub == "stream" and method == "GET":
            return 200, await self.stream(d, q), None
        if sub == "rpc" and method == "POST":
            j = json.loads(body or b"{}")
            return await self.rpc(d, j.get("op"), j.get("args", {}), j.get("timeout_ms", 10000))
        if sub == "images" and method == "PUT" and len(parts) == 5:
            sha = parts[4].lower()
            if hashlib.sha256(body).hexdigest() != sha:
                return 400, {"error": "sha256 mismatch"}, None
            d.images[sha] = body
            return 200, {"sha256": sha, "size": len(body)}, None
        if sub == "install" and method == "POST":
            j = json.loads(body or b"{}")
            sha = (j.get("sha256") or "").lower()
            if sha not in d.images:
                return 404, {"error": "image not staged"}, None
            host = headers.get("host", "127.0.0.1")
            args = {"kind": j.get("kind", "app"), "url": f"http://{host}/device/images/{sha}",
                    "size": len(d.images[sha]), "sha256": sha, "sig": j.get("sig", ""),
                    "name": j.get("name", ""), "version": j.get("version", "")}
            return await self.rpc(d, "install", args, 15000)
        return 404, {"error": "not found"}, None

    async def stream(self, d, q):
        after = int(q.get("after", 0))
        kinds = set((q.get("kinds") or "log,event,metric,hello").split(","))
        limit = min(int(q.get("limit", 500)), 500)
        wait = min(float(q.get("wait", 0)), 25)

        def matching():
            return [i for i in d.items if i["seq"] > after and i["kind"] in kinds][:limit]

        items = matching()
        if not items and wait > 0:
            deadline = time.monotonic() + wait
            async with d.cond:
                while not items:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    try:
                        await asyncio.wait_for(d.cond.wait(), left)
                    except asyncio.TimeoutError:
                        pass
                    items = matching()
        nxt = items[-1]["seq"] if items else max(after, d.seq)
        return {"items": items, "next": nxt, "online": d.ws is not None}

    async def rpc(self, d, op, args, timeout_ms):
        if d.ws is None:
            return 409, {"error": "device offline"}, None
        timeout_ms = min(int(timeout_ms or 10000), 60000)
        self.req_counter += 1
        rid = f"r-{self.req_counter}"
        fut = asyncio.get_running_loop().create_future()
        d.pending[rid] = fut
        await d.ws.send_text(json.dumps({"t": "req", "id": rid, "op": op, "args": args or {}}))
        try:
            res = await asyncio.wait_for(fut, timeout_ms / 1000)
        except asyncio.TimeoutError:
            return 504, {"error": f"timeout waiting for {op}"}, None
        finally:
            d.pending.pop(rid, None)
        out = {"ok": bool(res.get("ok"))}
        if out["ok"]:
            out["data"] = res.get("data", {})
        else:
            out["error"] = res.get("error", "error")
        return 200, out, None

    # ------------------------------------------------------------------ WebSocket
    async def device_ws(self, reader, writer, headers):
        d = self.by_client(headers.get("x-dev-client-id", ""))
        if not d:
            writer.write(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        key = headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        await writer.drain()
        conn = WsConn(reader, writer)
        if d.ws is not None:
            await d.ws.close()
        d.ws = conn
        d.connected_at = now_ms()
        self.log(f"{d.id} connected")
        try:
            while True:
                msg = await conn.recv()
                if msg is None:
                    break
                d.last_seen = now_ms()
                if msg == "ping":
                    await conn.send_text("pong")
                    continue
                try:
                    f = json.loads(msg)
                except ValueError:
                    self.log("bad json from device", msg[:80])
                    continue
                await self.on_frame(d, conn, f)
        finally:
            if d.ws is conn:
                d.ws = None
                for fut in d.pending.values():
                    if not fut.done():
                        fut.set_result({"ok": False, "error": "device disconnected"})
            self.log(f"{d.id} disconnected")
            try:
                writer.close()
            except Exception:
                pass

    async def on_frame(self, d, conn, f):
        t = f.get("t")
        data = {k: v for k, v in f.items() if k != "t"}
        if t == "hello":
            d.hello = data
            d.boot_id = data.get("boot_id")
            await d.add("hello", data)
            d.last_ack = d.stored_log_seq.get(d.boot_id, 0)
            await conn.send_text(json.dumps({"t": "ack", "seq": d.last_ack}))
        elif t == "log":
            seq0 = int(data.get("seq", 0))
            lines = data.get("lines", [])
            stored = d.stored_log_seq.get(d.boot_id, 0)
            fresh = [ln for i, ln in enumerate(lines) if seq0 + i > stored]
            if fresh:
                first = seq0 + len(lines) - len(fresh)
                await d.add("log", {"seq": first, "lines": fresh})
            last = seq0 + len(lines) - 1
            d.stored_log_seq[d.boot_id] = max(stored, last)
            d.last_ack = d.stored_log_seq[d.boot_id]
            await conn.send_text(json.dumps({"t": "ack", "seq": d.last_ack}))
        elif t == "metric":
            await d.add("metric", data)
        elif t == "event":
            await d.add("event", data)
        elif t == "res":
            fut = d.pending.get(f.get("id"))
            if fut and not fut.done():
                fut.set_result(f)
        else:
            self.log("unknown frame", t)


class WsConn:
    def __init__(self, reader, writer):
        self.r = reader
        self.w = writer
        self.lock = asyncio.Lock()

    async def send_text(self, s):
        payload = s.encode()
        n = len(payload)
        if n < 126:
            hdr = struct.pack("!BB", 0x81, n)
        elif n < 65536:
            hdr = struct.pack("!BBH", 0x81, 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x81, 127, n)
        async with self.lock:
            self.w.write(hdr + payload)
            await self.w.drain()

    async def close(self):
        try:
            async with self.lock:
                self.w.write(b"\x88\x00")
                await self.w.drain()
            self.w.close()
        except Exception:
            pass

    async def recv(self):
        buf = b""
        while True:
            try:
                b0, b1 = await self.r.readexactly(2)
            except (asyncio.IncompleteReadError, ConnectionError):
                return None
            fin, op, masked, n = b0 & 0x80, b0 & 0x0F, b1 & 0x80, b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", await self.r.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", await self.r.readexactly(8))[0]
            mask = await self.r.readexactly(4) if masked else b"\0\0\0\0"
            data = bytearray(await self.r.readexactly(n))
            for i in range(n):
                data[i] ^= mask[i % 4]
            if op == 0x8:
                return None
            if op == 0x9:
                async with self.lock:
                    self.w.write(bytes([0x8A, len(data)]) + bytes(data))
                    await self.w.drain()
                continue
            if op == 0xA:
                continue
            if len(data) > MAX_FRAME:
                print("[hub] WARNING: device frame exceeds 16 KiB", file=sys.stderr)
            buf += bytes(data)
            if fin:
                return buf.decode("utf-8")


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    hub = Hub(a.verbose)
    server = await asyncio.start_server(hub.handle, a.host, a.port, limit=1 << 20)
    print(f"mock hub listening on http://{a.host}:{a.port}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
