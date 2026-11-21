#!/usr/bin/env python3
"""QEMU end-to-end test for esp-launcher (ESP32 classic, OpenCores Ethernet).

Boots the launcher in Espressif QEMU with NVS pre-seeded (hub ws://10.0.2.2:<port>, cid
qemu-dev) and drives it through the hub operator API (/ops/*), against either the real hub
(wrangler dev, DEV_INSECURE=1) or test/mock_hub.py.

Python stdlib only. Needs IDF_PATH (for nvs_partition_gen / esptool) and qemu-system-xtensa.
"""
import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FW = os.path.dirname(HERE)

# Default efuse image used by `idf.py qemu` for esp32 (chip revision 3).
EFUSE_ESP32 = binascii.unhexlify(
    "00000000000000000000000000800000000000000000100000000000000000000000000000000000"
    + "0" * 160 + "00000000")


class Fail(Exception):
    pass


class Hub:
    def __init__(self, base, dev):
        self.base = base.rstrip("/")
        self.dev = dev
        self.cursor = 0

    def req(self, method, path, body=None, raw=None, timeout=70):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if raw is not None:
            r.add_header("Content-Type", "application/octet-stream")
        elif body is not None:
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {"error": str(e)}

    def rpc(self, op, args=None, timeout_ms=15000):
        st, j = self.req("POST", f"/ops/devices/{self.dev}/rpc",
                         {"op": op, "args": args or {}, "timeout_ms": timeout_ms})
        if st != 200:
            raise Fail(f"rpc {op}: HTTP {st} {j}")
        return j

    def mark(self):
        """Advance the cursor past everything already stored."""
        while True:
            st, j = self.req("GET", f"/ops/devices/{self.dev}/stream?after={self.cursor}"
                                    f"&kinds=log,event,metric,hello&limit=500&wait=0")
            if st != 200:
                raise Fail(f"stream: HTTP {st} {j}")
            items = j.get("items", [])
            self.cursor = max(self.cursor, int(j.get("next", self.cursor)))
            if not items:
                return self.cursor

    def wait_for(self, kinds, pred, timeout, after=None, collect=None):
        """Return the first stream item (seq > after) of `kinds` matching pred."""
        start = self.cursor if after is None else after
        deadline = time.time() + timeout
        pos = start
        while time.time() < deadline:
            wait = max(1, min(25, int(deadline - time.time())))
            st, j = self.req("GET", f"/ops/devices/{self.dev}/stream?after={pos}&kinds={kinds}"
                                    f"&limit=500&wait={wait}", timeout=wait + 10)
            if st != 200:
                raise Fail(f"stream: HTTP {st} {j}")
            for it in j.get("items", []):
                pos = max(pos, it["seq"])
                if collect is not None:
                    collect.append(it)
                if pred(it):
                    self.cursor = max(self.cursor, it["seq"])
                    return it
            pos = max(pos, int(j.get("next", pos)))
        return None


def log_lines(item):
    """Flatten a log stream item; tolerant to per-frame or per-line storage."""
    d = item.get("data") or {}
    if isinstance(d, dict) and "lines" in d:
        for ln in d["lines"]:
            yield ln[0], ln[1], ln[2]
    elif isinstance(d, list) and len(d) == 3:
        yield d[0], d[1], d[2]
    elif isinstance(d, dict) and "text" in d:
        yield d.get("ts", d.get("uptime_ms", 0)), d.get("level", "I"), d["text"]


def ev_name(item):
    d = item.get("data") or {}
    return d.get("name")


def ev_data(item):
    return (item.get("data") or {}).get("data") or {}


def hello_role(item):
    return (item.get("data") or {}).get("role")


class Runner:
    def __init__(self, a):
        self.a = a
        self.results = []
        self.hub = Hub(a.hub_url, a.device_id)
        self.out = a.out
        self.qemu = None
        self.boot_id = None

    def record(self, name, ok, detail):
        self.results.append((name, ok, detail))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}", flush=True)

    # ------------------------------------------------------------------ image
    def build_flash(self):
        a = self.a
        idf = os.environ.get("IDF_PATH")
        if not idf:
            raise Fail("IDF_PATH not set (source export.sh)")
        lb = a.launcher_build
        os.makedirs(self.out, exist_ok=True)
        csv = os.path.join(self.out, "nvs.csv")
        with open(csv, "w") as f:
            f.write("key,type,encoding,value\nokl,namespace,,\n"
                    f"hub,data,string,ws://10.0.2.2:{a.device_port}\n"
                    f"cid,data,string,{a.device_id}\nname,data,string,qemu-launcher\n")
        nvs_bin = os.path.join(self.out, "nvs.bin")
        gen = os.path.join(idf, "components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py")
        subprocess.run([sys.executable, gen, "generate", csv, nvs_bin, "0x6000"], check=True,
                       stdout=subprocess.DEVNULL)
        flash = os.path.join(self.out, "flash.bin")
        subprocess.run([sys.executable, "-m", "esptool", "--chip", "esp32", "merge_bin",
                        "--fill-flash-size", "16MB", "-o", flash,
                        "0x1000", os.path.join(lb, "bootloader/bootloader.bin"),
                        "0x8000", os.path.join(lb, "partition_table/partition-table.bin"),
                        "0x9000", nvs_bin,
                        "0xf000", os.path.join(lb, "ota_data_initial.bin"),
                        "0x20000", os.path.join(lb, "esp-launcher.bin")],
                       check=True, stdout=subprocess.DEVNULL)
        with open(os.path.join(self.out, "efuse.bin"), "wb") as f:
            f.write(EFUSE_ESP32)
        return flash

    def start_qemu(self, flash):
        serial = os.path.join(self.out, "serial.log")
        cmd = [self.a.qemu, "-M", "esp32", "-m", "4M",
               "-drive", f"file={flash},if=mtd,format=raw",
               "-drive", f"file={os.path.join(self.out, 'efuse.bin')},if=none,format=raw,id=efuse",
               "-global", "driver=nvram.esp32.efuse,property=drive,value=efuse",
               "-global", "driver=timer.esp32.timg,property=wdt_disable,value=true",
               "-nic", "user,model=open_eth",
               "-display", "none", "-monitor", "none", "-serial", f"file:{serial}"]
        print("qemu:", " ".join(cmd), flush=True)
        self.qemu = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=open(os.path.join(self.out, "qemu.stderr"), "w"))

    def stop(self):
        if self.qemu and self.qemu.poll() is None:
            self.qemu.terminate()
            try:
                self.qemu.wait(5)
            except subprocess.TimeoutExpired:
                self.qemu.kill()

    # ------------------------------------------------------------------ helpers
    def wait_hello(self, role, timeout, after=None, not_boot=None):
        def ok(it):
            d = it.get("data") or {}
            return d.get("role") == role and (not_boot is None or d.get("boot_id") != not_boot)
        it = self.hub.wait_for("hello", ok, timeout, after=after)
        if it:
            self.boot_id = it["data"].get("boot_id")
        return it

    def sign(self, binpath, key, outdir):
        r = subprocess.run([os.path.join(FW, "tools/sign.sh"), binpath, key, "hello-app", "0.1.0", "esp32",
                            "app", outdir], check=True, capture_output=True, text=True)
        man = json.load(open(os.path.join(outdir, "hello-app-0.1.0-esp32.manifest.json")))
        return man

    def heartbeat_intervals(self, after, count, timeout):
        stamps = []

        def pred(it):
            for ts, lvl, text in log_lines(it):
                if "heartbeat" in text:
                    stamps.append(ts)
            return len(stamps) >= count
        self.hub.wait_for("log", pred, timeout, after=after)
        return [b - a for a, b in zip(stamps, stamps[1:])]

    # ------------------------------------------------------------------ tests
    def run(self):
        a = self.a
        st, j = self.hub.req("PUT", f"/ops/devices/{a.device_id}", {"client_id": a.device_id, "label": "qemu"})
        if st != 200:
            raise Fail(f"registry PUT failed: {st} {j}")
        start = self.hub.mark()
        self.start_qemu(self.build_flash())

        # 1. hello
        it = self.wait_hello("launcher", a.boot_timeout, after=start)
        if not it:
            self.record("launcher hello", False, "no hello within %ds" % a.boot_timeout)
            return
        h = it["data"]
        need = ["proto", "boot_id", "role", "fw", "partition", "chip", "mac", "reset_reason", "rolled_back",
                "pending_install", "heap_free", "uptime_ms"]
        missing = [k for k in need if k not in h]
        self.record("launcher hello", not missing and h["proto"] == 1 and h["chip"] == "esp32",
                    f"partition={h.get('partition')} fw={h.get('fw')} reset={h.get('reset_reason')} "
                    f"heap_free={h.get('heap_free')} missing={missing}")
        r = self.hub.rpc("status")
        parts = {p["label"]: p for p in r.get("data", {}).get("partitions", [])}
        hp = self.hub.rpc("cmd", {"name": "heap", "argv": []}).get("data", {}).get("output", "").strip()
        self.record("status", r.get("ok") and "app" in parts and "launcher_a" in parts,
                    f"ip={r.get('data', {}).get('ip')} app={parts.get('app', {}).get('state')} launcher heap: {hp}")

        # 2. logs arrive and are acked
        got = self.hub.wait_for("log", lambda it: any("agent start" in t or "hub connected" in t
                                                      for _, _, t in log_lines(it)), 30, after=start)
        time.sleep(1.5)
        r = self.hub.rpc("cmd", {"name": "logstat", "argv": []})
        out = r.get("data", {}).get("output", "")
        m = re.search(r"acked_upto (\d+)", out)
        acked = int(m.group(1)) if m else 0
        sample = next(log_lines(got)) if got else None
        self.record("logs arrive + acked", bool(got) and acked > 0, f"sample={sample} logstat='{out.strip()}'")

        # 3. cmd help round trip
        r = self.hub.rpc("cmd", {"name": "help", "argv": []})
        out = r.get("data", {}).get("output", "")
        r2 = self.hub.rpc("cmd", {"name": "nope", "argv": []})
        r3 = self.hub.rpc("cmd.list")
        self.record("cmd help", r.get("ok") and "help" in out and "logstat" in out and not r2.get("ok"),
                    f"help lines={len(out.splitlines())}; unknown -> {r2.get('error')}; "
                    f"cmd.list={len(r3.get('data', {}).get('commands', []))}")

        # 4. install hello_app
        signdir = os.path.join(self.out, "signed")
        man = self.sign(a.app_bin, os.path.join(FW, "keys/dev_priv.pem"), signdir)
        img = open(os.path.join(signdir, "hello-app-0.1.0-esp32.bin"), "rb").read()
        st, j = self.hub.req("PUT", f"/ops/devices/{a.device_id}/images/{man['sha256']}", raw=img)
        mark = self.hub.mark()
        st2, j2 = self.hub.req("POST", f"/ops/devices/{a.device_id}/install",
                               {"kind": "app", "sha256": man["sha256"], "sig": man["sig"],
                                "name": "hello-app", "version": "0.1.0"})
        events = []
        done = self.hub.wait_for("event", lambda it: ev_name(it) in ("install.done", "install.failed"),
                                 a.install_timeout, after=mark, collect=events)
        prog = [ev_data(e).get("written") for e in events if ev_name(e) == "install.progress"]
        ok = done is not None and ev_name(done) == "install.done"
        self.record("install accepted+done", ok and st == 200 and j2.get("ok"),
                    f"stage={st} {j} install={st2} {j2} progress={prog} final={ev_name(done) if done else None} "
                    f"{ev_data(done) if done else ''}")
        if not ok:
            return
        it = self.wait_hello("app", a.boot_timeout, after=mark)
        self.record("app hello (role app)", bool(it),
                    f"partition={it['data'].get('partition')} fw={it['data'].get('fw', {}).get('name')}"
                    if it else "no app hello")
        if not it:
            return
        app_boot = it["data"]["boot_id"]
        valid = self.hub.wait_for("event", lambda e: ev_name(e) == "app.valid", 30, after=mark)
        r = self.hub.rpc("status")
        parts = {p["label"]: p for p in r.get("data", {}).get("partitions", [])}
        hp = self.hub.rpc("cmd", {"name": "heap", "argv": []}).get("data", {}).get("output", "").strip()
        self.record("app marked valid", bool(valid) and parts.get("app", {}).get("state") == "valid",
                    f"event={bool(valid)} app.state={parts.get('app', {}).get('state')} app heap: {hp}")

        # 5. param.set period_ms changes the heartbeat interval
        r = self.hub.rpc("param.get", {"name": "period_ms"})
        before = self.heartbeat_intervals(self.hub.mark() - 0, 3, 20)
        bad = self.hub.rpc("param.set", {"name": "period_ms", "value": 50})
        mark = self.hub.mark()
        r2 = self.hub.rpc("param.set", {"name": "period_ms", "value": 500, "persist": True})
        after = self.heartbeat_intervals(mark, 6, 20)[1:]
        okp = (r2.get("ok") and not bad.get("ok") and after and all(350 <= x <= 800 for x in after))
        self.record("param.set period_ms", bool(okp),
                    f"get={r.get('data')} before={before} out_of_range -> {bad.get('error')} "
                    f"set={r2.get('data')} after={after}")

        # 6. cmd crash
        mark = self.hub.mark()
        r = self.hub.rpc("cmd", {"name": "crash", "argv": []})
        it = self.hub.wait_for("hello", lambda x: x["data"].get("boot_id") != app_boot, a.boot_timeout, after=mark)
        if it:
            d = it["data"]
            self.record("cmd crash -> reboot", True,
                        f"res={r.get('data')} next boot: role={d.get('role')} partition={d.get('partition')} "
                        f"reset_reason={d.get('reset_reason')} rolled_back={d.get('rolled_back')}")
            role_after_crash = d.get("role")
        else:
            self.record("cmd crash -> reboot", False, "no hello after crash")
            return
        r = self.hub.rpc("param.get", {"name": "period_ms"}) if role_after_crash == "app" else {}
        if role_after_crash == "app":
            self.record("param persisted across reboot", r.get("data", {}).get("value") == 500, f"{r.get('data')}")

        # 6b. bootloader rollback: app (re)started by the launcher crashes before the hub ack
        if role_after_crash == "app":
            self.hub.rpc("param.set", {"name": "crash_boots", "value": 1})
            mark = self.hub.mark()
            self.hub.rpc("reboot", {"target": "launcher"})
            it = self.wait_hello("launcher", a.boot_timeout, after=mark)
            mark = self.hub.mark()
            rr = self.hub.rpc("reboot", {"target": "app"}) if it else {}
            it = self.hub.wait_for("hello", lambda x: x["data"].get("role") == "launcher", a.boot_timeout + 30,
                                   after=mark)
            app_hello = self.hub.wait_for("hello", lambda x: x["data"].get("role") == "app", 1, after=mark)
            s = self.hub.rpc("status") if it else {}
            parts = {p["label"]: p for p in s.get("data", {}).get("partitions", [])}
            self.record("rollback: crash before ack -> launcher", bool(it) and it["data"].get("rolled_back") is True
                        and app_hello is None,
                        f"reboot app={rr.get('ok')} launcher hello rolled_back={it['data'].get('rolled_back') if it else None}"
                        f" app hello seen={app_hello is not None} app.state={parts.get('app', {}).get('state')}")
            ev = self.hub.wait_for("event", lambda x: x["data"].get("name") == "rollback", 20, after=mark)
            evd = (ev or {}).get("data", {}).get("data") or {}
            self.record("rollback event reported", bool(ev) and evd.get("kind") == "app"
                        and evd.get("partition") == "app" and evd.get("detected_by") == "launcher",
                        f"event={json.dumps(evd)}")

            # 6c. fail_boots: valid app crashes before ack on 3 boots -> SDK boots the launcher
            mark = self.hub.mark()
            self.hub.rpc("reboot", {"target": "app"})
            it = self.wait_hello("app", a.boot_timeout, after=mark)
            if it:
                self.hub.wait_for("event", lambda e: ev_name(e) == "app.valid", 30, after=mark)
                self.hub.rpc("param.set", {"name": "crash_boots", "value": 3})
                mark = self.hub.mark()
                self.hub.rpc("reboot", {"target": "self"})
                it = self.hub.wait_for("hello", lambda x: True, a.boot_timeout * 3, after=mark)
                self.record("fail_boots=3 -> launcher", bool(it) and it["data"].get("role") == "launcher",
                            f"first hello after 3 crashing boots: role={it['data'].get('role') if it else None} "
                            f"reset_reason={it['data'].get('reset_reason') if it else None}")
                mark = self.hub.mark()
                self.hub.rpc("reboot", {"target": "app"})
                it = self.wait_hello("app", a.boot_timeout, after=mark)
                self.record("app runs again after reboot target=app", bool(it), "")

        # 7. reboot target=launcher (+ stays there)
        mark = self.hub.mark()
        r = self.hub.rpc("reboot", {"target": "launcher"})
        it = self.wait_hello("launcher", a.boot_timeout, after=mark)
        stayed = False
        if it:
            time.sleep(6)
            s = self.hub.rpc("status")
            stayed = s.get("data", {}).get("role") == "launcher"
        self.record("reboot target=launcher", bool(it) and r.get("ok") and stayed,
                    f"res ok={r.get('ok')} hello={'yes' if it else 'no'} still launcher after 6 s={stayed}")

        # 7b. coredump from the crash
        r = self.hub.rpc("coredump")
        d = r.get("data", {})
        e1 = self.hub.rpc("coredump.erase")
        r2 = self.hub.rpc("coredump")
        self.record("coredump op", r.get("ok") and d.get("present") is True and r2.get("data", {}).get("present")
                    is False, f"present={d.get('present')} summary={json.dumps(d.get('summary'))[:200]} "
                    f"erase ok={e1.get('ok')} after erase present={r2.get('data', {}).get('present')}")
        # 7c. the core dump names the exact ELF and symbolizes to source
        elf = os.path.join(os.path.dirname(a.app_bin), "hello-app.elf")
        sm = d.get("summary") or {}
        elf_sha = hashlib.sha256(open(elf, "rb").read()).hexdigest() if os.path.exists(elf) else ""
        frames = []
        if sm.get("backtrace"):
            sj = os.path.join(self.out, "coredump-summary.json")
            json.dump(sm, open(sj, "w"))
            pr = subprocess.run([sys.executable, os.path.join(FW, "tools/symbolize.py"), "--summary-json", sj,
                                 "--elf", elf, "--chip", "esp32", "--json"], capture_output=True, text=True)
            if pr.returncode == 0:
                frames = json.loads(pr.stdout).get("frames", [])
        joined = " | ".join(frames)
        dump_sha = sm.get("app_elf_sha256") or ""
        sha_ok = len(dump_sha) >= 8 and elf_sha.startswith(dump_sha)  # prefix when RETRIEVE_LEN < 64
        self.record("coredump symbolized", sha_ok and "abort" in joined and "hello_app/main/main.c" in joined,
                    f"dump elf sha={dump_sha} matches built ELF={sha_ok} frames={joined[:300]}")

        # 8. bad signature is rejected
        badkey = os.path.join(self.out, "bad_priv.pem")
        subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", badkey],
                       check=True)
        baddir = os.path.join(self.out, "badsig")
        bad = self.sign(a.app_bin, badkey, baddir)
        self.hub.req("PUT", f"/ops/devices/{a.device_id}/images/{bad['sha256']}", raw=img)
        mark = self.hub.mark()
        st2, j2 = self.hub.req("POST", f"/ops/devices/{a.device_id}/install",
                               {"kind": "app", "sha256": bad["sha256"], "sig": bad["sig"],
                                "name": "hello-app", "version": "0.1.0"})
        res = self.hub.wait_for("event", lambda it: ev_name(it) in ("install.done", "install.failed"),
                                a.install_timeout, after=mark)
        rb = self.hub.rpc("reboot", {"target": "app"})
        self.record("bad signature rejected",
                    res is not None and ev_name(res) == "install.failed" and "signature" in
                    ev_data(res).get("error", "") and not rb.get("ok"),
                    f"install={j2} event={ev_name(res) if res else None} {ev_data(res) if res else ''}; "
                    f"reboot target=app afterwards -> {rb.get('error')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hub-url", default="http://127.0.0.1:8787", help="operator API base")
    ap.add_argument("--device-port", type=int, default=8787, help="hub port as seen from QEMU (10.0.2.2)")
    ap.add_argument("--device-id", default="qemu-dev")
    ap.add_argument("--launcher-build", default=os.path.join(FW, "launcher/build/esp32-qemu"))
    ap.add_argument("--app-bin", default=os.path.join(FW, "examples/hello_app/build/esp32-qemu/hello-app.bin"))
    ap.add_argument("--qemu", default=shutil.which("qemu-system-xtensa") or "qemu-system-xtensa")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--boot-timeout", type=int, default=90)
    ap.add_argument("--install-timeout", type=int, default=240)
    a = ap.parse_args()
    r = Runner(a)
    t0 = time.time()
    try:
        r.run()
    except Fail as e:
        r.record("harness", False, str(e))
    except Exception as e:  # report, never hang CI
        r.record("harness", False, repr(e))
    finally:
        r.stop()
    print("\n==== summary (%.0f s) ====" % (time.time() - t0))
    for name, ok, _ in r.results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    print(f"serial log: {os.path.join(a.out, 'serial.log')}")
    with open(os.path.join(a.out, "results.json"), "w") as f:
        json.dump([{"name": n, "ok": o, "detail": d} for n, o, d in r.results], f, indent=1)
    sys.exit(0 if r.results and all(ok for _, ok, _ in r.results) else 1)


if __name__ == "__main__":
    main()
