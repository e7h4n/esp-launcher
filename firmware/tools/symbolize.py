#!/usr/bin/env python3
"""Turn an esp-launcher core dump summary into source locations.

The device keeps the last crash in its `coredump` partition; the launcher's `coredump` op
returns a summary with the crashing task, PC, backtrace and `app_elf_sha256`. CI publishes the
ELF of every release next to the binaries, with `elf_sha256` in the release manifest. This tool
finds the ELF whose SHA-256 matches and runs addr2line over the backtrace.

    # from Okou (the hub connector injects the Access headers):
    symbolize.py --device paper-1
    # from anywhere, with an explicit summary and ELF:
    symbolize.py --summary-json summary.json --elf hello-app-0.1.42-esp32s3.elf

Python stdlib only. Needs an ESP-IDF toolchain addr2line on PATH (or --addr2line).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

UA = {"User-Agent": "esp-launcher-symbolize/1"}


def http_json(url, method="GET", body=None, headers=None):
    h = dict(UA)
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def access_headers():
    cid, sec = os.environ.get("CF_ACCESS_CLIENT_ID"), os.environ.get("CF_ACCESS_CLIENT_SECRET")
    return {"CF-Access-Client-Id": cid, "CF-Access-Client-Secret": sec} if cid and sec else {}


def summary_from_device(hub, device):
    r = http_json(f"{hub}/ops/devices/{device}/rpc", "POST", {"op": "coredump"}, access_headers())
    if not r.get("ok"):
        sys.exit(f"coredump op failed: {r.get('error')} (the coredump op runs in the launcher; "
                 f"reboot the device with target=launcher first)")
    d = r["data"]
    if not d.get("present"):
        sys.exit("no core dump stored on the device")
    return d["summary"]


def find_elf(repo, elf_sha, workdir):
    """Search recent releases' manifest.json for a matching elf_sha256 and download that ELF."""
    releases = http_json(f"https://api.github.com/repos/{repo}/releases?per_page=50")
    for rel in releases:
        assets = {a["name"]: a["browser_download_url"] for a in rel.get("assets", [])}
        if "manifest.json" not in assets:
            continue
        try:
            entries = http_json(assets["manifest.json"])
        except Exception:
            continue
        for e in entries:
            full = e.get("elf_sha256") or ""
            if full and (full.startswith(elf_sha) or elf_sha.startswith(full)):
                name = f'{e["name"]}-{e["version"]}-{e["chip"]}.elf'
                if name not in assets:
                    continue
                path = os.path.join(workdir, name)
                with urllib.request.urlopen(urllib.request.Request(assets[name], headers=UA), timeout=120) as r, \
                        open(path, "wb") as f:
                    shutil.copyfileobj(r, f)
                return path, e, rel["tag_name"]
    return None, None, None


def addr2line_bin(explicit, chip):
    cands = [explicit] if explicit else []
    if chip and chip.startswith(("esp32c", "esp32h", "esp32p")):
        cands += ["riscv32-esp-elf-addr2line"]
    else:
        cands += [f"xtensa-{(chip or 'esp32s3').split('-')[0]}-elf-addr2line", "xtensa-esp-elf-addr2line"]
    for c in cands:
        if c and shutil.which(c):
            return shutil.which(c)
    sys.exit(f"addr2line not found (tried {cands}); source ESP-IDF export.sh or pass --addr2line")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", help="hub device id; fetches the summary via the coredump op")
    ap.add_argument("--hub", default="https://hub.c3p0.dev")
    ap.add_argument("--summary-json", help="file with the coredump summary object (instead of --device)")
    ap.add_argument("--elf", help="ELF to use (skips the release lookup)")
    ap.add_argument("--repo", default="e7h4n/esp-launcher", help="GitHub repo whose releases carry the ELFs")
    ap.add_argument("--chip", help="chip for picking addr2line when --elf is given (default esp32s3)")
    ap.add_argument("--addr2line")
    ap.add_argument("--json", action="store_true", help="print a JSON result")
    a = ap.parse_args()

    if a.summary_json:
        s = json.load(open(a.summary_json))
        s = s.get("summary", s)
    elif a.device:
        s = summary_from_device(a.hub.rstrip("/"), a.device)
    else:
        sys.exit("give --device or --summary-json")
    addrs = [x for x in [s.get("pc")] + list(s.get("backtrace") or []) if x]
    elf_sha = (s.get("app_elf_sha256") or "").strip()

    with tempfile.TemporaryDirectory() as tmp:
        elf, entry, tag = a.elf, None, None
        if not elf:
            if not elf_sha:
                sys.exit("summary has no app_elf_sha256; pass --elf")
            elf, entry, tag = find_elf(a.repo, elf_sha, tmp)
            if not elf:
                sys.exit(f"no released ELF with elf_sha256 {elf_sha} in {a.repo} "
                         "(local build? pass --elf)")
        chip = a.chip or (entry or {}).get("chip")
        out = subprocess.run([addr2line_bin(a.addr2line, chip), "-pfiaC", "-e", elf] + addrs,
                             capture_output=True, text=True, check=True).stdout
        frames = [ln.strip() for ln in out.splitlines() if ln.strip()]
        result = {"task": s.get("task"), "app_elf_sha256": elf_sha, "elf": os.path.basename(elf),
                  "release": tag, "frames": frames, "backtrace_corrupted": s.get("backtrace_corrupted")}
        if a.json:
            print(json.dumps(result, indent=1))
        else:
            print(f"task {result['task']}  elf {result['elf']}" + (f"  ({tag})" if tag else ""))
            for f in frames:
                print("  " + f)


if __name__ == "__main__":
    main()
