#!/usr/bin/env python3
"""Production end-to-end check of the hub through real Cloudflare Access.

A simulated device connects with a device service token (SIM_CLIENT_ID/SECRET) and an operator
uses an ops service token (OPS_CLIENT_ID/SECRET). Secrets come from the environment only and are
never printed. Checks: access isolation, hello/ack, log storage, rpc round trip, param.set,
image staging + install request + authenticated image download by the device.

    pip install 'websockets>=14'
    HUB=hub.c3p0.dev SIM_CLIENT_ID=.. SIM_CLIENT_SECRET=.. OPS_CLIENT_ID=.. OPS_CLIENT_SECRET=.. \
        python3 hub/test/prod_e2e.py
"""
import asyncio
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

import websockets

HUB = os.environ.get("HUB", "hub.c3p0.dev")
UA = "esp-launcher-e2e/0.1"
DEV = os.environ.get("SIM_DEVICE_ID", "sim-1")
SIM = (os.environ["SIM_CLIENT_ID"], os.environ["SIM_CLIENT_SECRET"])
OPS = (os.environ["OPS_CLIENT_ID"], os.environ["OPS_CLIENT_SECRET"])
results = []


def hdr(tok):
    h = {"User-Agent": UA}
    if tok:
        h["CF-Access-Client-Id"], h["CF-Access-Client-Secret"] = tok
    return h


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def http(method, path, tok=OPS, body=None, raw=None, timeout=40):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = hdr(tok)
    if body is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"https://{HUB}{path}", data=data, method=method, headers=h)
    try:
        with _opener.open(req, timeout=timeout) as r:
            b = r.read()
            st = r.status
    except urllib.error.HTTPError as e:
        b, st = e.read(), e.code
    try:
        return st, json.loads(b or b"{}")
    except ValueError:
        return st, {"_raw": b[:200].decode("utf-8", "replace")}


def record(name, ok, detail=""):
    results.append((name, ok))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}", flush=True)


class SimDevice:
    def __init__(self):
        self.boot_id = secrets.token_hex(4)
        self.acks = []
        self.reqs = []
        self.params = {"period_ms": 2000}
        self.downloaded = None

    async def run(self, ready):
        url = f"wss://{HUB}/device/connect"
        async with websockets.connect(url, additional_headers=hdr(SIM), user_agent_header=UA,
                                      open_timeout=20) as ws:
            self.ws = ws
            await ws.send(json.dumps({"t": "hello", "proto": 1, "boot_id": self.boot_id, "role": "app",
                                      "fw": {"name": "prod-sim", "version": "0.0.1", "idf": "sim", "sha256": "0" * 64},
                                      "partition": "app", "chip": "sim", "mac": "02:00:00:00:00:01",
                                      "reset_reason": "ESP_RST_POWERON", "rolled_back": False,
                                      "pending_install": None, "heap_free": 1, "uptime_ms": 1}))
            ready.set()
            async for msg in ws:
                if msg == "pong":
                    continue
                m = json.loads(msg)
                if m.get("t") == "ack":
                    self.acks.append(m["seq"])
                elif m.get("t") == "req":
                    self.reqs.append(m)
                    await ws.send(json.dumps(await self.handle(m)))

    async def handle(self, m):
        op, a = m["op"], m.get("args") or {}
        if op == "status":
            return {"t": "res", "id": m["id"], "ok": True, "data": {"role": "app", "boot_id": self.boot_id}}
        if op == "param.set":
            v = a.get("value")
            if not isinstance(v, int) or not 200 <= v <= 10000:
                return {"t": "res", "id": m["id"], "ok": False, "error": "period_ms out of range [200, 10000]"}
            self.params[a["name"]] = v
            return {"t": "res", "id": m["id"], "ok": True, "data": {"name": a["name"], "value": v}}
        if op == "install":
            st, body = await asyncio.to_thread(self.fetch_image, a["url"])
            self.downloaded = (st, hashlib.sha256(body).hexdigest() if st == 200 else None)
            ok = st == 200 and self.downloaded[1] == a["sha256"]
            return {"t": "res", "id": m["id"], "ok": ok, "data": {"accepted": ok, "http": st}}
        return {"t": "res", "id": m["id"], "ok": False, "error": f"unknown op {op}"}

    def fetch_image(self, url):
        req = urllib.request.Request(url, headers=hdr(SIM))
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, b""

    async def send_logs(self, lines):
        await self.ws.send(json.dumps({"t": "log", "seq": 1, "lines": lines}))


async def main():
    t0 = time.time()
    # access isolation (no device needed)
    st, _ = http("GET", "/ops/devices", tok=None)
    record("ops without credentials is blocked", st in (302, 401, 403), f"HTTP {st}")
    st, _ = http("GET", "/ops/devices", tok=SIM)
    record("device token cannot reach /ops", st in (401, 403), f"HTTP {st}")
    st, j = http("GET", "/ops/devices")
    record("ops token lists devices", st == 200 and "devices" in j, f"HTTP {st} n={len(j.get('devices', []))}")
    st, j = http("PUT", f"/ops/devices/{DEV}", body={"client_id": SIM[0], "label": "prod simulator"})
    record("register simulator", st == 200 and j.get("id") == DEV, f"HTTP {st}")
    st, j = http("GET", f"/ops/devices/{DEV}/stream?after=0&limit=1")
    cursor = 0
    st, j = http("GET", f"/ops/devices/{DEV}/stream?after=0&limit=2000")
    if st == 200 and j.get("items"):
        cursor = j["items"][-1]["seq"]

    sim = SimDevice()
    ready = asyncio.Event()
    task = asyncio.create_task(sim.run(ready))
    try:
        await asyncio.wait_for(ready.wait(), 25)
    except asyncio.TimeoutError:
        record("device connects through Access", False, repr(task.exception() if task.done() else "timeout"))
        return
    await asyncio.sleep(1.5)
    record("device connects through Access", not task.done(), f"acks={sim.acks}")
    record("hello acked", sim.acks[:1] == [0], f"acks={sim.acks}")
    await sim.send_logs([[10, "I", "prod e2e line 1"], [11, "W", "prod e2e line 2"]])
    await asyncio.sleep(1.5)
    record("log acked", 2 in sim.acks, f"acks={sim.acks}")

    st, j = await asyncio.to_thread(http, "GET", f"/ops/devices/{DEV}/stream?after={cursor}&kinds=hello,log&wait=5")
    kinds = [(it["kind"], it.get("boot_id")) for it in j.get("items", [])]
    texts = [ln[2] for it in j.get("items", []) if it["kind"] == "log" for ln in it["data"]["lines"]]
    record("stream has hello + logs", ("hello", sim.boot_id) in kinds and "prod e2e line 2" in texts, f"{kinds} {texts}")

    st, j = await asyncio.to_thread(http, "GET", f"/ops/devices/{DEV}")
    record("device shows online", st == 200 and j.get("online") is True, f"online={j.get('online')} role={j.get('role')}")

    st, j = await asyncio.to_thread(http, "POST", f"/ops/devices/{DEV}/rpc", OPS, {"op": "status"})
    record("rpc status round trip", st == 200 and j.get("ok") and j["data"].get("boot_id") == sim.boot_id, f"HTTP {st} {j}")
    st, j = await asyncio.to_thread(http, "POST", f"/ops/devices/{DEV}/rpc", OPS,
                                    {"op": "param.set", "args": {"name": "period_ms", "value": 50}})
    record("param.set out of range rejected", st == 200 and j.get("ok") is False, f"{j}")
    st, j = await asyncio.to_thread(http, "POST", f"/ops/devices/{DEV}/rpc", OPS,
                                    {"op": "param.set", "args": {"name": "period_ms", "value": 500}})
    record("param.set applied", j.get("ok") and sim.params["period_ms"] == 500, f"{j}")

    img = os.urandom(300 * 1024)
    sha = hashlib.sha256(img).hexdigest()
    st, j = await asyncio.to_thread(http, "PUT", f"/ops/devices/{DEV}/images/{sha}", OPS, None, img)
    record("stage image", st == 200 and j.get("size") == len(img), f"HTTP {st} {j}")
    st, j = await asyncio.to_thread(http, "POST", f"/ops/devices/{DEV}/install", OPS,
                                    {"kind": "app", "sha256": sha, "sig": "dGVzdA==", "name": "x", "version": "0"})
    record("install request + device image download", st == 200 and j.get("ok") and sim.downloaded == (200, sha),
           f"HTTP {st} {j} downloaded={sim.downloaded}")
    inst = [r for r in sim.reqs if r["op"] == "install"]
    record("install url points at hub", bool(inst) and inst[0]["args"]["url"] == f"https://{HUB}/device/images/{sha}",
           inst[0]["args"]["url"] if inst else "no install req")
    st, _ = await asyncio.to_thread(http, "GET", f"/device/images/{sha}", OPS)
    record("ops token cannot download device images", st in (401, 403), f"HTTP {st}")

    task.cancel()
    await asyncio.sleep(2)
    st, j = await asyncio.to_thread(http, "GET", f"/ops/devices/{DEV}")
    record("device shows offline after disconnect", j.get("online") is False, f"online={j.get('online')}")
    print(f"==== {sum(ok for _, ok in results)}/{len(results)} passed in {time.time() - t0:.0f} s")


asyncio.run(main())
sys.exit(0 if results and all(ok for _, ok in results) else 1)
