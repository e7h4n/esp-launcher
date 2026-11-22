# Python runtime app

The launcher and the `okou_agent` SDK stay C. This app adds MicroPython on top, so device logic is
a Python script on the device filesystem: change it over the hub in seconds, no reflash. The
native image changes only when a new C binding is needed, and then it is installed like any app
(signed, A/B, rollback).

Base: M5Stack's [UIFlow2 MicroPython](https://github.com/m5stack/uiflow-micropython) (MIT,
pinned in `.github/workflows/pyrt.yml`). It already has the M5 hardware bindings: `M5` (display,
touch, buttons, speaker, power, IMU, RTC), `Widgets`, plus MicroPython's `machine`, `bluetooth`,
`socket`, `ssl`, `asyncio`.

## What is different from UIFlow2

- `okl_runtime_start()` (C, before MicroPython) starts the SDK: Wi-Fi from the launcher's saved
  networks, the hub link, logs, commands, installs; and SNTP (TLS checks certificate dates).
- Our frozen `_boot.py`: no UIFlow menu, Wi-Fi or cloud. The `data` partition (LittleFS) is
  mounted at `/flash`; `main.py` there runs at boot. `print()` goes to the hub log.
- Do not use `network.WLAN` in scripts: the SDK owns Wi-Fi (sockets and `requests2` work).
- Smaller image: minimal frozen manifest, no Japanese/Korean 24 px fonts (Chinese kept). CI fails
  if the image does not fit the 4 MiB `app` slot of `partitions/16mb.csv`.
- `okou` module: `okou.connected()`, `okou.event(name, json=None)`, `okou.metric(name, value)`.

## Develop over the hub

```bash
tools/pyrt.py okl-c17d24 put pyrt/examples/papercolor_hello.py main.py
tools/pyrt.py okl-c17d24 reset            # soft reset: main.py runs again
tools/pyrt.py okl-c17d24 eval 'M5.Power.getBatteryLevel()'
tools/pyrt.py okl-c17d24 exec 'print(n)'  # inspect the running script's globals
tools/pyrt.py okl-c17d24 logs 60
tools/pyrt.py okl-c17d24 safe-boot        # main.py wedged? reboot once without it
```

Ops: `py.exec`, `py.interrupt`, `py.reset`, `py.safe_boot`, `term.write` (docs/protocol.md).

## Build

CI only (`.github/workflows/pyrt.yml`, ESP-IDF v5.5.5): checks out UIFlow2 at the pinned commit,
runs `apply_overlay.py` (each edit asserts its anchor), builds, checks the size, and on `main`
signs and publishes `app-pyrt-<board>-v<version>`.
