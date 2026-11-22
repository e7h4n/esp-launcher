// Local end-to-end test of the Clerk-era API: developer secrets, device tokens, ownership,
// device WebSocket relay. Run against `npm run dev` (DEV_INSECURE=1 enables X-Dev-User).
//   node test/api_local.mjs [http://127.0.0.1:8787]
const BASE = process.argv[2] || "http://127.0.0.1:8787";
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`);
  if (!cond) failed++;
};
async function call(path, { user, key, token, method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (user) headers["X-Dev-User"] = user;
  if (key || token) headers.authorization = `Bearer ${key || token}`;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, j };
}

const A = "user_test_a", B = "user_test_b";
const dev = `t-${Date.now().toString(36)}`;

// developer secrets
let r = await call("/api/keys", { user: A, method: "POST", body: { label: "test" } });
check("create developer secret", r.status === 200 && r.j.secret?.startsWith("okl_key_"));
const key = r.j.secret, keyId = r.j.id;
r = await call("/api/keys", { user: A });
check("list secrets (no secret values)", r.j.keys.some((k) => k.id === keyId) && !JSON.stringify(r.j).includes(key));
r = await call("/api/me", { key });
check("secret authenticates as its owner", r.j.user_id === A && r.j.via === "key");
r = await call("/api/keys", { key, method: "POST", body: {} });
check("secret cannot mint secrets", r.status === 403);
r = await call("/api/me", { key: "okl_key_bogus" });
check("unknown secret rejected", r.status === 401);

// devices and ownership
r = await call("/api/devices", { key, method: "POST", body: { device_id: dev, label: "Test" } });
check("add device returns a device token", r.status === 200 && r.j.token?.startsWith("okl_dev_"));
const token = r.j.token;
r = await call("/api/devices", { user: B, method: "POST", body: { device_id: dev } });
check("other user cannot take the id", r.status === 409);
r = await call(`/api/devices/${dev}`, { user: B });
check("other user cannot see the device", r.status === 404);
r = await call("/api/devices", { key });
check("owner lists the device, no token hash", r.j.devices.some((d) => d.id === dev) && !JSON.stringify(r.j).includes("token_hash"));
r = await call("/api/me", { token });
check("device token is not a developer credential", r.status === 401);
r = await call(`/api/device/images/${"0".repeat(64)}`, { key });
check("developer secret is not a device credential", r.status === 401);

// device connects with its token; developer talks to it through the hub
const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/device/connect", { headers: { authorization: `Bearer ${token}` } });
const acked = new Promise((resolve, reject) => {
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", proto: 1, boot_id: "b1", role: "app", fw: { name: "fake", version: "1.0", idf: "x", sha256: "0" }, partition: "app", chip: "esp32s3", mac: "00:00:00:00:00:00", reset_reason: "ESP_RST_POWERON", rolled_back: false, pending_install: null }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "ack") resolve();
    if (m.t === "req" && m.op === "auth.set" && globalThis.refuseAuthSet) {
      ws.send(JSON.stringify({ t: "res", id: m.id, ok: false, error: "unknown op: auth.set" }));
    } else if (m.t === "req") {
      if (m.op === "auth.set") globalThis.gotToken = m.args.token;
      ws.send(JSON.stringify({ t: "res", id: m.id, ok: true, data: { echo: m.op, args: m.args } }));
    }
  };
  ws.onerror = (e) => reject(new Error("ws error " + (e.message || "")));
  setTimeout(() => reject(new Error("no ack")), 8000);
});
try {
  await acked;
  check("device connects with its token and gets hello ack", true);
} catch (e) {
  check("device connects with its token and gets hello ack", false, e.message);
}
r = await call(`/api/devices/${dev}/rpc`, { key, method: "POST", body: { op: "status" } });
check("developer secret drives the device (rpc relay)", r.status === 200 && r.j.data?.echo === "status", JSON.stringify(r.j));
const img = new Uint8Array([0xe9, 1, 2, 3]);
const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", img))].map((b) => b.toString(16).padStart(2, "0")).join("");
let rr = await fetch(`${BASE}/api/devices/${dev}/images/${sha}`, { method: "PUT", headers: { authorization: `Bearer ${key}` }, body: img });
check("stage image with developer secret", rr.status === 200);
r = await call(`/api/devices/${dev}/install`, { key, method: "POST", body: { kind: "app", sha256: sha, version: "1.1" } });
check("install without a signature is relayed", r.status === 200 && r.j.data?.echo === "install" && r.j.data.args.url.includes("/api/device/images/"), JSON.stringify(r.j?.data?.args?.url || r.j));
rr = await fetch(`${BASE}/api/device/images/${sha}`, { headers: { authorization: `Bearer ${token}` } });
const got = new Uint8Array(await rr.arrayBuffer());
check("device pulls the image with its token", rr.status === 200 && got.length === 4 && got[0] === 0xe9);

// online reset: old firmware refuses auth.set -> nothing changes
globalThis.refuseAuthSet = true;
r = await call(`/api/devices/${dev}/rotate`, { key, method: "POST" });
check("rotate on old firmware is refused", r.status === 409 && /auth.set/.test(r.j.error), JSON.stringify(r.j));
rr = await fetch(`${BASE}/api/device/images/${sha}`, { headers: { authorization: `Bearer ${token}` } });
check("refused rotation keeps the old token", rr.status === 200);
// online reset: device takes the new token, old one is revoked
globalThis.refuseAuthSet = false;
r = await call(`/api/devices/${dev}/rotate`, { key, method: "POST" });
check("rotate over the live connection", r.status === 200 && r.j.rotated && globalThis.gotToken?.startsWith("okl_dev_"), JSON.stringify(r.j));
rr = await fetch(`${BASE}/api/device/images/${sha}`, { headers: { authorization: `Bearer ${globalThis.gotToken}` } });
check("new token works", rr.status === 200);
rr = await fetch(`${BASE}/api/device/images/${sha}`, { headers: { authorization: `Bearer ${token}` } });
check("old token revoked after rotation", rr.status === 401);
ws.close();
r = await call(`/api/devices/${dev}/rotate`, { key, method: "POST" });
check("rotate needs the device online", r.status === 409);

// cleanup
r = await call(`/api/devices/${dev}`, { key, method: "DELETE" });
check("owner deletes the device", r.status === 200);
r = await call("/api/device/images/" + sha, { token: globalThis.gotToken });
check("deleted device token stops working", r.status === 401);
r = await call(`/api/keys/${encodeURIComponent(keyId)}`, { user: A, method: "DELETE" });
r = await call("/api/me", { key });
check("revoked secret stops working", r.status === 401);

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
