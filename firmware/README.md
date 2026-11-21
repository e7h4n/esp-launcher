# esp-launcher firmware

Device half of esp-launcher (protocol: [`../docs/protocol.md`](../docs/protocol.md)). It has three parts:

| Path | What |
|---|---|
| `components/okou_agent/` | SDK that apps link (`okou_agent.h`): hub WebSocket, log tee, metrics, events, commands, params, rollback safety |
| `launcher/` | Headless launcher: signed OTA install, app auto-start, launcher self-update, core dump ops, BLE provisioning |
| `examples/hello_app/` | Sample app (heartbeat log, `counter` metric, `period_ms` param, `echo` and `crash` commands) |
| `partitions/16mb.csv`, `4mb.csv` | Flash layouts (labels fixed by the protocol; NVS stays at 0x9000/0x6000) |
| `tools/sign.sh` | ECDSA P-256 signing, writes `.sig` and manifests |
| `keys/` | Dev key pair (**TEST ONLY**) and `release_pub.pem` (currently a placeholder holding the dev key, see `keys/README.md`) |
| `test/` | QEMU end-to-end test, mock hub |

## Build (ESP-IDF v5.4.x)

    . $IDF_PATH/export.sh
    cd firmware/launcher            # or firmware/examples/hello_app
    # M5Stack StopWatch (ESP32-S3, 16 MB):
    idf.py -B build/esp32s3 -DIDF_TARGET=esp32s3 -DSDKCONFIG=build/esp32s3/sdkconfig build
    # ESP32 classic hardware (4 MB layout, Wi-Fi + BLE):
    idf.py -B build/esp32 -DIDF_TARGET=esp32 -DSDKCONFIG=build/esp32/sdkconfig build
    # ESP32 QEMU (16 MB layout, OpenCores Ethernet, dev key). In hello_app, use ../../ instead of ../:
    idf.py -B build/esp32-qemu -DIDF_TARGET=esp32 -DSDKCONFIG=build/esp32-qemu/sdkconfig \
      -DSDKCONFIG_DEFAULTS="../sdkconfig.common;sdkconfig.defaults;../sdkconfig.qemu" build

Config layering: `sdkconfig.common` (+ `.esp32`/`.esp32s3`) → project `sdkconfig.defaults` (+ target file) →
`sdkconfig.qemu` (QEMU only). `launcher` → `esp-launcher` → *Public key embedded…* chooses
`keys/release_pub.pem` (default), `keys/dev_pub.pem` (`CONFIG_OKL_KEY_DEV`, TEST ONLY) or a custom path.
Version comes from `firmware/version.txt`.

## First flash over USB (16 MB layout, ESP32-S3)

This flashes bootloader, partition table, otadata and the launcher. It does **not** touch
`0x9000–0xEFFF`, so an existing NVS (for example Wi-Fi settings stored by the previous firmware) is kept:

    cd firmware/launcher/build/esp32s3
    python -m esptool --chip esp32s3 -p /dev/ttyACM0 -b 460800 write_flash \
      --flash_mode dio --flash_freq 80m --flash_size 16MB \
      0x0 bootloader/bootloader.bin 0x8000 partition_table/partition-table.bin \
      0xf000 ota_data_initial.bin 0x20000 esp-launcher.bin

The previous app is overwritten. Rebuild it against the SDK and install it through the hub
(`PUT /ops/devices/<id>/images/<sha>`, then `POST /ops/devices/<id>/install`). For ESP32 classic with
the 4 MB layout, use `--chip esp32`, `0x1000` for the bootloader, `--flash_size 4MB`, `--flash_freq 40m`, and
launcher (`factory`) at `0x20000`.

## Provisioning

NVS namespace `okl`: `ssid`, `pass`, `hub`, `cid`, `csec`, `name`.

* **BLE** (launcher only, NimBLE). The launcher advertises `okl-<last 3 MAC bytes>` while it has no hub
  connection, or for 120 s after BOOT is held for 3 s. Write the JSON from the protocol to characteristic
  `6f6b6f75-0002-4c61-756e-636865720000`, ending it with `\n` (it may span several writes). Notifications
  are `{"ok":…}`, then `{"state":"wifi"|"hub"|"online"|"error",…}`. Negotiate an MTU of at least 64, because
  notifications are longer than 20 bytes.
* **Wi-Fi fallback:** if `okl/ssid` is missing, the SDK uses whatever the IDF Wi-Fi driver has already stored in NVS.
* **Lab / QEMU:** generate an NVS image and merge it at `0x9000`. See `test/qemu_e2e.py` (`nvs_partition_gen.py`).
  This replaces the whole NVS partition.
* `hub` is a host name (`hub.c3p0.dev` → `wss://hub.c3p0.dev/device/connect` with `CF-Access-Client-Id/Secret`
  and the IDF certificate bundle), or a `ws://host:port[/path]` dev URL (`X-Dev-Client-Id: <cid>`, no TLS,
  only for hubs running with `DEV_INSECURE=1`).

## Linking the SDK from an app

```c
#include "okou_agent.h"            // main/CMakeLists.txt: REQUIRES okou_agent
static int32_t beep_ms = 800;
static int cmd_tare(int argc, char **argv, okou_out_t *out) { okou_outf(out, "tared"); return 0; }
void app_main(void) {
    okou_param_int("beep_ms", &beep_ms, 50, 5000, true);    // persisted in NVS "okp"
    okou_cmd_register("tare", "zero the scale", cmd_tare);
    okou_agent_start(NULL);                                  // NVS, Wi-Fi, hub, rollback safety
    for (;;) {
        ESP_LOGI("app", "weight %.1f", 12.5);                // -> hub `log` frames
        okou_metric("weight_g", 12.5);                       // -> `metric`, batched
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
```
Add `set(EXTRA_COMPONENT_DIRS <path>/firmware/components)` in the project CMakeLists. Also use the same
partition table and enable `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`; `sdkconfig.common` can be reused.
If the app manages Wi-Fi itself, pass `okou_config_t` with `.manage_network = false`.
`.handlers_in_poll = true` with `okou_poll()` runs command handlers on the app's own task.

## Tests

    . $IDF_PATH/export.sh
    firmware/test/run_qemu_e2e.sh --build --mock     # mock hub (what CI runs)
    (cd hub && npm run dev) &                        # or a real hub (DEV_INSECURE=1, port 8787)
    firmware/test/run_qemu_e2e.sh --hub-url http://127.0.0.1:8787

Logs land in `firmware/test/out/` (`serial.log`, `results.json`).

## Behaviour notes / extensions to the protocol

* Log `seq` starts at 1. Any `ack` after `hello` counts as the hello acknowledgement, and acks only release
  lines that were already sent.
* App install hand-off (`okl/pending`) stores the install args plus an `attempts` counter. The launcher
  retries at most 3 times (after reboots), then reports `install.failed`.
* Image URLs whose path is `/device/images/<sha>` are always fetched from the configured hub base (so the
  hub token is never sent elsewhere, and a hub that reports `127.0.0.1` in `url` still works from QEMU).
  Other URLs are fetched without credentials.
* The first 4 KiB of an image is written only after size, SHA-256, signature and chip id all pass. A failed
  install therefore leaves an **empty** (unbootable) app slot, never an unverified one.
* `reboot target=launcher|self` (and `self` in the launcher) sets a one-shot `okl/hold`, so the launcher does
  not auto-start the app again 3 s later.
* After an app rollback or `fail_boots >= 3`, the launcher waits `CONFIG_OKL_FAILSAFE_WAIT_S` (30 s) instead
  of 3 s before starting the app again, then resets `fail_boots`.
* A launcher that was just self-updated must get a hub ack within `CONFIG_OKL_VALIDATE_TIMEOUT_S` (300 s).
  Otherwise it calls `esp_ota_mark_app_invalid_rollback_and_reboot()`. `okl/lslot` records the last validated
  launcher slot, which is used by `reboot target=launcher`.
* Extra built-in command `logstat`, and extra events `app.valid` and `launcher.valid`.

## RAM budget (SDK, defaults)

Log ring 16 KiB, TX frame buffer 6 KiB, agent task stack 6 KiB, WebSocket client task 5 KiB plus 2×2 KiB
buffers, metric ring 1.3 KiB, cmd/param tables about 1.5 KiB: **≈ 40 KiB static/long-lived**. Transient
allocations are command output (≤ 4 KiB), received frames (≤ 8 KiB each, queue depth 8) and up to 16
queued events. A `wss://` session adds the mbedTLS context (typically 35–45 KiB). The launcher install adds an
8 KiB task, 8 KiB of buffers and an HTTP client (plus TLS) only while an install runs. Every buffer is
bounded: when full, data is dropped and counted, and nothing blocks the caller.

## Known limitations

* Verified only in Espressif QEMU (ESP32 classic, Ethernet) against `test/mock_hub.py`. The ESP32-S3 and
  ESP32 4 MB builds compile but have not run on hardware. Wi-Fi, TLS to Cloudflare and BLE provisioning are
  compile-tested only.
* BLE provisioning is unauthenticated while open (no hub connection, or the BOOT window).
* Only `ESP_LOG*` output is captured. Plain `printf` is not, and lines over `CONFIG_OKOU_LOG_LINE_MAX`
  (192 B) are truncated. The vprintf hook formats into a 200 B buffer on the logging task's stack.
* Interrupted downloads restart from byte 0 (no HTTP range resume).
* QEMU builds wrap `esp_restart_noos()` into a full system reset (`CONFIG_OKOU_QEMU_SYSTEM_RESET`) to work
  around Espressif QEMU not resetting peripherals on a CPU reset. Hardware builds use the normal path.
* On the 4 MB layout, launcher self-update is USB only (`install kind=launcher` is rejected).
