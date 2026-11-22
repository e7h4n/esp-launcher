#!/usr/bin/env python3
"""Drive the esp-launcher Python runtime through the hub (no USB, no reflash).

  pyrt.py <device> exec  '<code>'            run code in __main__, print output / exception
  pyrt.py <device> eval  '<expr>'            print repr(expr)
  pyrt.py <device> put   <local> [<remote>]  upload a file (atomic replace, sha256 checked)
  pyrt.py <device> ls    [<dir>]
  pyrt.py <device> cat   <remote>
  pyrt.py <device> rm    <remote>
  pyrt.py <device> reset                     soft reset: boot.py and main.py run again
  pyrt.py <device> interrupt                 KeyboardInterrupt in the running script
  pyrt.py <device> safe-boot                 reboot once without main.py
  pyrt.py <device> logs  [<seconds>]         follow print()/log output

Hub: HUB env (default https://hub.c3p0.dev). Auth headers are added outside this tool (Okou
connector or an Access service token proxy); requests carry User-Agent okou-esp.
"""
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

HUB = os.environ.get("HUB", "https://hub.c3p0.dev")
CHUNK = 4096  # raw bytes per py.exec (base64 stays well under the 8 KiB device frame limit)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def call(dev, path, body=None, timeout=70):
    req = urllib.request.Request(f"{HUB}/ops/devices/{dev}{path}", headers={"User-Agent": "okou-esp"})
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("content-type", "application/json")
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}


def rpc(dev, op, args=None, timeout_ms=30000):
    r = call(dev, "/rpc", {"op": op, "args": args or {}, "timeout_ms": timeout_ms}, timeout=timeout_ms / 1000 + 10)
    if not r.get("ok"):
        sys.exit(f"{op}: {r.get('error') or r}")
    return r.get("data") or {}


def run(dev, code, eval_=False, quiet=False, timeout_ms=30000):
    d = rpc(dev, "py.exec", {"code": code, "eval": eval_}, timeout_ms)
    if not quiet and d.get("output"):
        sys.stdout.write(d["output"])
    if d.get("exception"):
        sys.stderr.write(d["exception"])
        sys.exit(1)
    return d


def put(dev, local, remote):
    data = open(local, "rb").read()
    tmp = remote + ".part"
    for i in range(0, max(len(data), 1), CHUNK):
        b64 = base64.b64encode(data[i:i + CHUNK]).decode()
        mode = "wb" if i == 0 else "ab"
        run(dev, f"import binascii\nwith open({tmp!r},{mode!r}) as f: f.write(binascii.a2b_base64({b64!r}))", quiet=True)
    want = hashlib.sha256(data).hexdigest()
    run(dev, f"import hashlib,binascii\n_h=hashlib.sha256()\n_f=open({tmp!r},'rb')\n"
             f"while True:\n _b=_f.read(1024)\n if not _b: break\n _h.update(_b)\n_f.close()", quiet=True)
    got = run(dev, "binascii.hexlify(_h.digest()).decode()", eval_=True, quiet=True)["result"].strip("'")
    if got != want:
        sys.exit(f"sha256 mismatch on device: {got} != {want}")
    run(dev, f"import os\ntry:\n os.remove({remote!r})\nexcept OSError:\n pass\nos.rename({tmp!r},{remote!r})", quiet=True)
    print(f"{local} -> {remote} ({len(data)} bytes, sha256 {want[:12]})")


def logs(dev, seconds):
    nxt = call(dev, "/stream?after=0&limit=1&kinds=none").get("next", 0)
    end = time.time() + seconds
    while time.time() < end:
        d = call(dev, f"/stream?after={nxt}&kinds=log,event&limit=500&wait=20", timeout=40)
        for it in d.get("items", []):
            x = it["data"]
            if it["kind"] == "log":
                for ln in x.get("lines", []):
                    print(f"{ln[1]} {ln[2]}")
            else:
                print(f"event {x.get('name')} {json.dumps(x.get('data'))}")
        nxt = d.get("next", nxt)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    dev, cmd, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    if cmd == "exec":
        run(dev, rest[0])
    elif cmd == "eval":
        print(run(dev, rest[0], eval_=True, quiet=True)["result"])
    elif cmd == "put":
        put(dev, rest[0], rest[1] if len(rest) > 1 else os.path.basename(rest[0]))
    elif cmd == "ls":
        print(run(dev, f"__import__('os').listdir({(rest[0] if rest else '/flash')!r})", eval_=True, quiet=True)["result"])
    elif cmd == "cat":
        run(dev, f"print(open({rest[0]!r}).read(), end='')")
    elif cmd == "rm":
        run(dev, f"import os\nos.remove({rest[0]!r})")
    elif cmd == "reset":
        rpc(dev, "py.reset")
    elif cmd == "interrupt":
        print(rpc(dev, "py.interrupt"))
    elif cmd == "safe-boot":
        rpc(dev, "py.safe_boot")
    elif cmd == "logs":
        logs(dev, float(rest[0]) if rest else 60)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
