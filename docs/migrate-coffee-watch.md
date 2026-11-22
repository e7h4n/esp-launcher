# Migrating Coffee Watch (M5Stack StopWatch) to esp-launcher

One USB session with Ethan present. Everything after it (logs, commands, updates) is remote.

## What changes on flash

| Range | Before (coffee-watch schema 2) | After (16mb-legacy) | Written? |
|---|---|---|---|
| 0x0 bootloader | rollback-enabled (from coffee-watch PR #11) | same | no |
| 0x8000 partition table | ota_0/ota_1 4 MB | launcher_a/b 2.5 MB, app 2.94 MB, coredump | yes |
| 0x9000 nvs (Wi-Fi, Dropbox, calibration) | | unchanged | **no** |
| 0xf000 phy_init | | unchanged | no |
| 0x10000 | ota_0 | launcher_a | yes (launcher) |
| 0x510000 | (inside ota_1) | app | yes (coffee-watch launcher variant) |
| 0x810000 otadata | | erased, bootloader starts launcher_a | erase only |
| 0x812000 storage | | unchanged | **no** |

## Prerequisites

1. Device token: create Access service token `esp-dev-coffee-watch` (Zero Trust → Service
   credentials), then run the `hub` workflow (workflow_dispatch) so `esp-hub-device` allows it.
2. Register it: `PUT https://hub.c3p0.dev/ops/devices/coffee-watch {"client_id": "<id>", "label": "Coffee Watch"}`.
3. Artifacts: esp-launcher esp32s3 release (`esp-launcher-<v>-esp32s3.bin`, partition table from
   the same build) and the coffee-watch launcher variant bin (coffee-watch PR #13 CI artifact).
4. Watch idle, brews saved, on USB to the Mac. esptool from ESP-IDF on the Mac.

## Steps

```bash
firmware/tools/migrate_legacy_16mb.sh /dev/cu.usbmodemXXXX partition-table.bin \
  esp-launcher-<v>-esp32s3.bin coffee-watch-launcher-app-<v>-esp32s3.bin ~/private-migration-backups
# then, with the Wi-Fi + device token payload in a private file:
python3 firmware/tools/provision_serial.py --port /dev/cu.usbmodemXXXX < payload.json
```

The script backs up all 16 MiB first, refuses to continue unless the current table is the
expected legacy layout, and never writes nvs/phy/storage/bootloader.

## Verify

1. Hub shows `coffee-watch` online with `role=launcher`, then `role=app`, `fw.name=coffee_watch_demo`.
2. `POST /ops/devices/coffee-watch/rpc {"op":"cmd","args":{"name":"console","argv":["help"]}}`
   returns `queued`, and the console output shows up in the stream.
3. On the watch: Wi-Fi, Dropbox upload, scales and brew history still work.
4. Power-cycle on battery: the watch must stay on (StopWatch PM1 power hold in the launcher).

## Remote updates (after migration)

Coffee Watch CI builds the launcher variant unsigned. esp-launcher signs it, so the release key
never leaves this repository:

```bash
gh workflow run sign-app.yml -R e7h4n/esp-launcher -f run_id=<coffee-watch Actions run id>
# -> release app-coffee-watch-v0.1.<run> (bin, sig, manifest, ELF), never marked Latest
```

Then stage the image (`PUT /ops/devices/coffee-watch/images/<sha256>`) and
`POST /ops/devices/coffee-watch/install {"kind":"app","sha256":...,"sig":...,"version":...}`.
The running app stores the request and reboots into the launcher. The launcher downloads the
image, checks its signature and boots it. The app marks itself valid after its local health
check (`okou_app_mark_valid()`). Expected stream:
`hello role=launcher` → `install.done` → `hello role=app` → `app.valid {"by":"app"}`. This
takes about 30 s for 2.2 MB. Verified on 2026-11-22 with v0.1.12 and v0.1.13.

Once the app runs, a reset boots the app directly, not the launcher. The wireless way back is
`install` or `reboot target=launcher` sent to an app that is **online**. An app that cannot reach
the hub can only be updated over USB (write the app bin to 0x510000). That is why the launcher
variant must keep its hub connection healthy:

- **Wi-Fi**: the SDK owns it (`manage_network = true`) and uses the networks saved by the
  launcher. The watch's own network was migrated once into that list (`wifi list`).
- **Clock**: TLS checks certificate dates, so the app starts SNTP on the first IP. Without
  SNTP the handshake fails with -0x2700.
- **Internal RAM**: BLE, the display and Dropbox TLS leave little internal RAM for the SDK
  tasks. The variant moves the Wi-Fi hot paths and non-ISR FreeRTOS functions out of IRAM, and
  NimBLE buffers to PSRAM. v0.1.13 reports `heap_internal_free` ≈ 30 KB and
  `heap_internal_largest` ≈ 21 KB; the hub task needs about 5.5 KB.

## Rollback

`esptool.py --chip esp32s3 -p PORT -b 921600 write_flash 0 <backup>.bin` restores the exact
previous state, including the old partition table.
