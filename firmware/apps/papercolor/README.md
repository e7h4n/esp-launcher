# PaperColor app

esp-launcher app for the **M5Stack PaperColor** (C151: ESP32-S3R8, 16 MB flash, 8 MB OPI PSRAM,
4" E Ink Spectra 6 400x600, ES8311 + AW8737A speaker, WS2812 LED on G21, M5PM1 PMIC), built on
M5Unified / M5GFX 0.3.0 (official PaperColor board support).

| Behaviour | How |
|---|---|
| Boot | green LED blinks 3 times, two-tone chime |
| Power button | left to the PM1: double click powers off immediately in hardware (like pulling the battery, no LED). A single click gets a short beep. Remote `poweroff confirm` blinks red 3 times, plays a low tone and powers off |
| Not online within 45 s, or offline for 2 min | e-paper shows Chrome URL `hub.c3p0.dev/ops/setup`, a QR code and the BLE name `okl-xxxxxx`, then `okou_enter_setup()` hands over to the launcher (BLE provisioning open; the app comes back after the next hub ack) |
| Battery | top-right on every screen: percentage + icon (green, yellow at <=25%, red at <=10%, bolt on USB). Same source, discharge curve and 60 s sampling as the factory firmware's battery widget; the panel is redrawn only when the shown value is 10 points off, a threshold or USB power changes (battery-driven redraws at most every 10 min, except dropping to critical) |
| Online | e-paper shows Okou's official avatar (`static.vm0.io` default agent avatar SVG, rendered unmodified) and the device name |

Remote commands: `beep`, `led <r> <g> <b> [times]`, `show online|setup`, `offline_test confirm`,
`poweroff confirm`, `battery`.

Build: `idf.py -B build/esp32s3 -DIDF_TARGET=esp32s3 build` (CI builds and signs it as
`papercolor-app-<version>-esp32s3-generic.bin`). `partitions_app.csv` is a build-time table only.

Verified on hardware (device `okl-c17d24`, 2026-11-22): remote install, hub validation, avatar
refresh in 22 s, offline_test -> setup screen -> launcher setup mode -> back online.
