#!/usr/bin/env python3
"""Send an esp-launcher provisioning payload over USB serial (OKL-PROVISION line).

The JSON payload is read from stdin so secrets never appear in argv or shell history:

    python3 provision_serial.py --port /dev/cu.usbmodem1101 < payload.json

payload.json: {"wifi":{"ssid":"..","pass":".."},"hub":"hub.c3p0.dev",
               "token":{"id":"<CF Access client id>","secret":"<client secret>"},"name":"coffee-watch"}
Prints only OK/ERR, never the payload. Requires pyserial (bundled with esptool).
"""
import argparse
import json
import sys
import time

import serial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True)
    ap.add_argument("--timeout", type=float, default=15)
    a = ap.parse_args()
    payload = json.loads(sys.stdin.read())
    line = "OKL-PROVISION " + json.dumps(payload, separators=(",", ":")) + "\n"
    if len(line) > 630:
        sys.exit("payload too long for the launcher (max ~630 bytes)")
    with serial.Serial(a.port, 115200, timeout=0.2) as s:
        time.sleep(0.5)
        s.reset_input_buffer()
        s.write(line.encode())
        s.flush()
        deadline = time.time() + a.timeout
        buf = b""
        while time.time() < deadline:
            buf += s.read(256)
            for raw in buf.split(b"\n"):
                txt = raw.decode("utf-8", "replace").strip()
                if txt.startswith("OKL-PROVISION-OK"):
                    print("provisioned")
                    return 0
                if txt.startswith("OKL-PROVISION-ERR"):
                    print(txt)
                    return 1
            buf = buf[-512:]
    print("no answer from launcher (is the launcher running on this port?)")
    return 2


if __name__ == "__main__":
    sys.exit(main())
