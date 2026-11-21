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

## Rollback

`esptool.py --chip esp32s3 -p PORT -b 921600 write_flash 0 <backup>.bin` restores the exact
previous state, including the old partition table.
