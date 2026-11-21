# esp-launcher

Remote development and update for ordinary ESP32 devices.

A small **launcher** firmware plus an **SDK** (`okou_agent`) that every app links. The device
dials out over WebSocket to a **hub** (Cloudflare Worker + Durable Object) behind Cloudflare
Access. An operator (a person or an AI agent) then reads live logs, metrics and events, calls
commands, tunes parameters and installs signed firmware, without USB.

```
device (launcher | app + SDK) --WSS--> Cloudflare Access /device/* --> Worker --> DeviceHub DO
operator (Okou, human)        --HTTPS> Cloudflare Access /ops/*    --> Worker --> DeviceHub DO
```

- `docs/protocol.md`: the device/hub/operator contract.
- `firmware/`: ESP-IDF launcher, `okou_agent` SDK, `hello_app` example, QEMU end-to-end tests.
- `hub/`: Cloudflare Worker + Durable Objects (SQLite storage), operator HTTP API.

## Safety model

- Only the bootloader and partition table need USB (first flash and recovery).
- Apps are marked valid only after the hub acknowledged their `hello`; a crash before that, or
  3 boots without the hub, returns to the launcher. Launcher self-update is A/B with rollback.
- The launcher only installs images signed by the release key (ECDSA P-256). The private key
  lives only in CI.
- Each device has its own Cloudflare Access service token; device tokens cannot reach `/ops/*`.

## Status

- QEMU end-to-end suite (16 cases, ESP32 with emulated Ethernet) passes against the real hub code.
- Production hub `hub.c3p0.dev`: deployed by CI, Access-protected; a simulated device passes the
  17-case production e2e on every hub deploy.
- **Real hardware (2026-11-22, ESP32-S3R8 board on USB to a Cardputer Zero):** generic launcher
  flashed over USB, provisioned over USB serial, joined Wi-Fi, connected through Cloudflare Access
  with its own service token; then remotely: status, commands, a CI-signed app installed over the
  network (streamed, signature-checked, switched, marked valid after hub ack), live logs and
  metrics, real-time `param.set` with persistence, reboot to launcher and back.
- Also on that board (2026-11-22): remote launcher self-update in both directions
  (launcher_a <-> launcher_b, signed, validated after hub ack, then app auto-start); launcher
  rollback (chip reset while the new launcher was pending verify -> bootloader returned to the
  old launcher); app crash before hub ack -> rollback to the launcher (`rolled_back=true`,
  app `aborted`) with a readable core dump.
- Not yet on hardware: BLE provisioning, M5Stack StopWatch board bring-up.

MIT licensed.
