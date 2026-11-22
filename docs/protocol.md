# esp-launcher protocol v1

This document is the contract between the device firmware (launcher and app SDK)
and the hub (Cloudflare Worker + Durable Object). Both sides must follow it exactly.

## Topology

```
device (launcher or app + SDK) --WSS--> Cloudflare Access (/device/*) --> Worker --> DeviceHub DO (one per device)
operator (Okou, human)         --HTTPS-> Cloudflare Access (/ops/*)    --> Worker --> DeviceHub DO
```

- Hub host: `hub.c3p0.dev` (configurable at provisioning time).
- Devices authenticate with a per-device Cloudflare Access service token, sent on every
  device request as headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- The Worker trusts only the `Cf-Access-Jwt-Assertion` header issued by Access. The device
  identity is the JWT `common_name` (service token client id), mapped to a device id by the
  hub registry. Anything the device says about its own id is informational only.

## Device endpoints

| Method | Path | Purpose |
|---|---|---|
| GET (WebSocket upgrade) | `/device/connect` | Long-lived control/telemetry channel |
| GET | `/device/images/<sha256>` | Download a firmware image staged for this device (binary, `Content-Length` set) |

Plain-text development mode (local tests only): when the hub runs with `DEV_INSECURE=1`
the device may instead send header `X-Dev-Client-Id: <client id>` and no Access headers.
Production never accepts it.

## WebSocket framing

- Text frames only. Every frame is one JSON object with a `t` (type) field, except the
  literal keep-alive strings below.
- Keep-alive: device sends the literal text `ping` every 30 s; hub answers literal `pong`
  (Durable Object auto-response, does not wake the object). If no `pong` arrives for 90 s the
  device closes and reconnects.
- Reconnect backoff: 1 s, 2 s, 4 s ... capped at 60 s, with ±20 % jitter. Reset after a
  connection stays up for 60 s.
- Max frame size: 16 KiB. Senders split larger payloads.

### Device -> hub

`hello` (first frame after connect, mandatory):
```json
{"t":"hello","proto":1,
 "boot_id":"9f1c2a7e",          // random 32-bit hex, new on every boot
 "role":"launcher",             // "launcher" | "app"
 "fw":{"name":"esp-launcher","version":"0.1.0","idf":"v5.4.1","sha256":"<elf sha256 from esp_app_desc>"},
 "partition":"launcher_a",      // running partition label
 "ota_state":"valid",           // running image: valid | pending_verify | new | unset (USB flash) | ...
 "chip":"esp32s3","mac":"aa:bb:cc:dd:ee:ff",
 "reset_reason":"ESP_RST_SW",
 "rolled_back":false,           // true when bootloader rolled back the previous image
 "pending_install":null,        // or {"sha256":"...","state":"..."} while an install is in progress
 "heap_free":123456,             // all heaps, PSRAM included
 "heap_internal_free":41000,     // internal RAM (task stacks, DMA); the scarce one on busy apps
 "heap_internal_largest":20480,  // largest internal block; the hub task needs about 5.5 KB
 "uptime_ms":4200}
```

`log` (batched console output; `seq` is the device-side sequence of the first line, scoped to `boot_id`):
```json
{"t":"log","seq":120,"lines":[[4210,"I","wifi: connected"],[4300,"W","scale: retry"]]}
```
Each line is `[uptime_ms, level, text]`; level is one of `E W I D V` or `O` (plain stdout).

`metric` (batched numeric samples):
```json
{"t":"metric","items":[["weight_g",4400,12.5],["flow_gps",4400,1.25]]}
```
Each item is `[name, uptime_ms, number]`.

`event` (named occurrences the operator can wait for):
```json
{"t":"event","name":"install.done","data":{"sha256":"...","version":"0.2.0"}}
```

Events emitted by the launcher/SDK themselves: `install.progress`, `install.done`,
`install.failed`, `app.valid`, `launcher.valid`, and `rollback`:
```json
{"t":"event","name":"rollback","data":{"partition":"launcher_a","kind":"launcher",
 "returned_to":"launcher_b","reset_reason":"ESP_RST_USB","detected_by":"launcher","boot_id":"9f1c2a7e"}}
```
The bootloader's record of an invalidated image is lost as soon as the next
`esp_ota_set_boot_partition()` rewrites otadata (for example the launcher auto-starting the app
before it reached the hub). So the first boot that sees it stores it in NVS (`okl/rb`), and
whichever role reaches the hub first reports it once, then deletes it.

`res` (answer to a hub request):
```json
{"t":"res","id":"r-17","ok":true,"data":{}}
{"t":"res","id":"r-17","ok":false,"error":"unknown command: foo"}
```

### Hub -> device

`ack` (log lines up to and including `seq` for the current `boot_id` are stored; the device may
drop them from its retain buffer):
```json
{"t":"ack","seq":135}
```

`req` (operator request; the device must answer with exactly one `res` with the same id):
```json
{"t":"req","id":"r-17","op":"cmd","args":{"name":"tare","argv":[]}}
```

### Operations (`req.op`)

| op | args | res.data | available in |
|---|---|---|---|
| `status` | `{}` | hello fields refreshed + `rssi`, `ip`, `partitions:[{label,subtype,offset,size,state}]` | launcher, app |
| `cmd` | `{"name":"tare","argv":["a"]}` | `{"output":"..."}` (handler text) | launcher, app |
| `cmd.list` | `{}` | `{"commands":[{"name","help"}]}` | launcher, app |
| `param.list` | `{}` | `{"params":[{"name","type","value","min","max","persist"}]}` | launcher, app |
| `param.get` | `{"name":"beep_ms"}` | `{"name","value"}` | launcher, app |
| `param.set` | `{"name":"beep_ms","value":800,"persist":true}` | `{"name","value"}`; rejects out-of-range | launcher, app |
| `reboot` | `{"target":"self"\|"launcher"\|"app"}` | `{}` sent before rebooting (~300 ms delay) | launcher, app |
| `install` | see below | `{"accepted":true}`; progress via events | launcher, app (app hands off to launcher) |
| `coredump` | `{}` | `{"present":bool,"summary":{...}}` | launcher |
| `coredump.erase` | `{}` | `{}` | launcher |

Built-in commands every device registers (via `cmd`): `help`, `version`, `heap`, `wifi`.

Python runtime app only (`firmware/pyrt`, see its README):

| op | args | res.data |
|---|---|---|
| `py.exec` | `{"code":"...", "eval":false}` | `{"output", "result" (eval only, repr), "exception" (traceback or null)}`; runs in `__main__` between bytecodes of the running script; one at a time; answer is deferred until the code finished (use `timeout_ms`) |
| `py.interrupt` | `{}` | `{"running":bool}`; KeyboardInterrupt in running code |
| `py.reset` | `{}` | `{}`; soft reset: `boot.py` and `main.py` run again (files are kept) |
| `py.safe_boot` | `{}` | `{}`; reboots once without running `main.py` |
| `term.write` | `{"data":"..."}` | `{}`; raw REPL input; Ctrl-C (`\u0003`) interrupts running code |

`print()` and REPL output arrive as log lines with level `O`.

`install` args:
```json
{"kind":"app",                       // "app" | "launcher"
 "url":"https://hub.c3p0.dev/device/images/<sha256>",
 "size":1048576,
 "sha256":"<hex of the whole .bin>",
 "sig":"<base64 DER ECDSA P-256 signature over the whole .bin (SHA-256)>",
 "name":"hello-app","version":"0.1.0"}
```

Install rules:
1. If the running role is `app`, the SDK stores the install args in NVS namespace `okl`, key
   `pending` and reboots into the launcher (`reboot target=launcher`). The launcher resumes the
   install after connecting.
2. The launcher streams the download into the target partition (`app` partition for kind=app,
   the inactive launcher slot for kind=launcher), hashing as it goes. Never buffers the full image.
3. Before switching the boot partition it verifies: size match, SHA-256 match, ECDSA signature
   valid against the public key compiled into the launcher, and the image header chip id matches.
4. Events: `install.progress` `{"sha256","written","size"}` at most every 10 %, then
   `install.done` `{"sha256","version","kind"}` or `install.failed` `{"sha256","error"}`.
5. On success it sets the boot partition and reboots. For kind=launcher the new launcher must
   connect to the hub and call `esp_ota_mark_app_valid_cancel_rollback()` only after its `hello`
   is acknowledged with `ack`; otherwise the bootloader rolls back.

## Boot and rollback rules

Partition roles (labels are fixed): `launcher_a`, `launcher_b` (ota_0, ota_1), `app` (ota_2).
Small-flash layout (4 MB) uses `factory` for the launcher and `app` (ota_0); launcher self-update is
then USB only. `partitions/16mb-legacy.csv` (used by the esp32s3 / M5Stack StopWatch builds) keeps
`nvs` 0x9000, `phy_init` 0xf000, `otadata` 0x810000 and `storage` 0x812000 of the classic IDF
dual-OTA layout, so migrating such a device rewrites only the partition table, otadata and the
app area (launcher slots 2.5 MB each, app 2.94 MB).

- `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` on all builds.
- The launcher boots the app by `esp_ota_set_boot_partition(app)` + restart. The new app starts
  in PENDING_VERIFY. The SDK marks it valid only after the hub acknowledged its `hello`.
  A crash, watchdog reset or power cycle before that rolls back to the launcher slot.
- Apps that must keep working offline set `okou_config_t.app_validates = true`: they mark
  themselves valid after their own startup health check by calling `okou_app_mark_valid()`
  (which reports `app.valid` with `by: "app"`), and the SDK applies neither the
  hub-ack validation nor the fail_boots safety net below. `CONFIG_OKOU_MAX_FAIL_BOOTS=0` also
  disables the safety net.
- Apps that let the SDK own Wi-Fi (`manage_network = true`) and build with
  `CONFIG_MBEDTLS_HAVE_TIME_DATE=y` must start SNTP once the station has an IP: the SDK does not
  (apps usually own SNTP), and the hub TLS handshake fails with -0x2700 (certificate dates) until
  the clock is set. The SDK logs a hint when this happens.
- The SDK's tasks (agent, Wi-Fi manager, hub websocket of about 5 KB) have internal-RAM stacks.
  Busy apps (BLE + display + TLS) should check `heap_internal_largest` in `status`; if the hub
  connection cannot start, the log says how much internal RAM was left.
- App-side safety net: the SDK keeps a counter in NVS `okl/fail_boots`. It is incremented at
  SDK start and reset to 0 once a hub `ack` is received. If it reaches 3, the SDK boots the
  launcher instead of continuing.
- `reboot target=launcher` from the app sets the boot partition to the last valid launcher slot.
- The launcher never auto-starts the app while `okl/pending` exists. Otherwise it starts the app
  automatically 3 s after boot if the app partition holds a valid image, unless a hub request
  arrived during that window or `okl/stay` is set (`param.set stay_in_launcher=1`).

## Provisioning (BLE)

GATT service UUID `6f6b6f75-0001-4c61-756e-636865720000` ("okou" + launcher), single
characteristic `...0002...` (write, notify). The client writes one JSON object (possibly in
several writes, terminated by `\n`):
```json
{"wifi":{"ssid":"...","pass":"..."},
 "hub":"hub.c3p0.dev",
 "token":{"id":"<CF-Access-Client-Id>","secret":"<CF-Access-Client-Secret>"},
 "name":"coffee-watch"}
```
The device stores it in NVS namespace `okl` (`ssid`, `pass`, `hub`, `cid`, `csec`, `name`),
answers with a notify `{"ok":true}` or `{"ok":false,"error":"..."}`, then tries to connect and
notifies `{"state":"wifi"|"hub"|"online"|"error","detail":"..."}`. BLE advertising name is
`okl-<last 3 MAC bytes hex>`. Provisioning is open only while the launcher has no hub
connection or the user holds the BOOT button for 3 s.

### Wi-Fi networks and scanning

- The `wifi` object of a provisioning payload (`{"ssid","pass","hidden"}`) **adds** a network to
  the saved list (NVS `okl/wifis`, up to 5, most recently used first); it never replaces the
  others. `okl/ssid`/`okl/pass` mirror the first entry for older launchers. A payload may carry
  only `wifi` (add a network to an already enrolled device).
- Connect loop: scan, try saved networks that are visible (strongest first), then the rest,
  including hidden ones (directed probe); back off up to 60 s; the network that works moves to
  the front.
- BLE requests (same characteristic, one JSON line each):
  - `{"op":"scan"}` -> one notification per visible network `{"ap":{"s","r","a","c"}}`
    (ssid, rssi, auth, channel; strongest first), then `{"scan":"done"|"failed","n":N}`.
  - `{"op":"saved"}` -> `{"saved_ap":{"ssid","hidden","open","current"}}` per saved network
    (never passwords), then `{"saved":"done","n":N}`.
- Remote command `wifi [list | scan | add <ssid> [pass] [hidden] | forget <ssid>]` does the
  same through the hub (passwords are never echoed).

### USB serial provisioning

The launcher also reads its console (USB-Serial-JTAG on ESP32-S3, UART0 otherwise). A line
`OKL-PROVISION <same JSON object>` stores the payload exactly like BLE and answers
`OKL-PROVISION-OK` or `OKL-PROVISION-ERR <reason>`. The line is never echoed or logged. This is
the path used during the first USB flash.

## Signing

- CI holds an ECDSA P-256 private key (GitHub secret `FIRMWARE_SIGNING_KEY`, PEM).
- `sig = base64(DER(ECDSA_sign(SHA256(bin))))`, produced with
  `openssl dgst -sha256 -sign key.pem -out x.sig x.bin`.
- The public key PEM lives in `firmware/keys/release_pub.pem` and is embedded in the launcher.
- Versions are `<major.minor from firmware/version.txt>.<CI run number>` (local builds:
  `<major.minor>.0-dev`); every push to main publishes its own release `fw-v<version>`.
- CI publishes for each build: `<name>-<version>-<chip>.bin`, `.sig` (base64 text), `.elf`
  (symbols) and `manifest.json` `{name, version, chip, role, size, sha256, sig, elf_sha256}`.
- `elf_sha256` equals the `app_elf_sha256` in the app descriptor and in core dump summaries
  (`CONFIG_APP_RETRIEVE_LEN_ELF_SHA=64`), so `firmware/tools/symbolize.py --device <id>` finds
  the exact ELF of a crash in the releases and prints the backtrace as source lines.

## Operator API (hub, `/ops/*`)

All responses are JSON. Errors: `{"error":"..."}` with a 4xx/5xx status.

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/ops/devices` | | `{"devices":[{id,label,online,role,fw,last_seen,token_expires_at}]}` |
| PUT | `/ops/devices/<id>` | `{"client_id","label","token_expires_at","writes_require_human":false}` | registry entry |
| DELETE | `/ops/devices/<id>` | | `{}` |
| GET | `/ops/devices/<id>` | | `{id,online,hello,connected_at,last_seen,...}` |
| GET | `/ops/devices/<id>/stream` | `after=<hub seq>&kinds=log,event,metric,hello&limit=500&wait=<s, max 25>` | `{"items":[{seq,kind,recv_at,boot_id,data}],"next":<seq>,"online":bool}` |
| POST | `/ops/devices/<id>/rpc` | `{"op","args","timeout_ms"}` (default 10 s, max 60 s) | `{"ok","data"\|"error"}`; 409 when offline |
| PUT | `/ops/devices/<id>/images/<sha256>` | raw bytes | `{"sha256","size"}`; rejects hash mismatch |
| POST | `/ops/devices/<id>/install` | `{"kind","sha256","sig","name","version", "url"?}` | rpc result of `install`; when `url` is given the hub fetches and stages it first |
| GET (WebSocket) | `/ops/devices/<id>/tail` | | live items, same shape as stream items |

Stream semantics: `seq` is assigned by the hub, strictly increasing per device. `wait` holds the
request open until at least one matching item exists or the timeout passes. Retention: 7 days or
200 000 items per device, whichever is smaller.
