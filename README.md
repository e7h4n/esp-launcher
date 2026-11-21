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

v0.1: the full QEMU end-to-end suite (16 cases, ESP32 with emulated Ethernet) passes against
the real hub code. Wi-Fi, TLS through Cloudflare and BLE provisioning still need real hardware.

MIT licensed.
