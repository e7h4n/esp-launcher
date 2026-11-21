// Idempotently create/update the two Cloudflare Access applications protecting the hub and
// print their AUD tags as GitHub env lines. Service tokens are looked up by name:
//   esp-dev-*      -> allowed on hub/device (Service Auth)
//   esp-ops-*      -> allowed on hub/ops    (Service Auth)
// plus OPS_ALLOWED_EMAILS (comma separated) as an identity Allow policy on hub/ops.
// Secrets never leave Cloudflare: this script only reads token ids and writes app config.
const A = process.env.CLOUDFLARE_ACCOUNT_ID;
const T = process.env.CLOUDFLARE_API_TOKEN;
const HOST = process.env.HUB_HOST || "hub.c3p0.dev";
const EMAILS = (process.env.OPS_ALLOWED_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!A || !T) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");

async function api(method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}${path}`, {
    method,
    headers: { Authorization: `Bearer ${T}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`${method} ${path} -> HTTP ${r.status} ${JSON.stringify(j.errors || j)}`);
  return j.result;
}

const tokens = await api("GET", "/access/service_tokens?per_page=100");
const pick = (prefix) => tokens.filter((t) => t.name.startsWith(prefix)).map((t) => ({ service_token: { token_id: t.id } }));
const deviceIncl = pick("esp-dev-");
const opsIncl = pick("esp-ops-");
const apps = await api("GET", "/access/apps?per_page=100");

async function ensure(name, path, policies) {
  const body = {
    name,
    domain: `${HOST}/${path}`,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    service_auth_401_redirect: true,
    policies,
  };
  const existing = apps.find((a) => a.name === name);
  const app = existing ? await api("PUT", `/access/apps/${existing.id}`, body) : await api("POST", "/access/apps", body);
  console.error(`${existing ? "updated" : "created"} ${name} (${body.domain}) policies=${policies.length}`);
  return app.aud;
}

const devicePolicies = deviceIncl.length
  ? [{ name: "esp devices", decision: "non_identity", include: deviceIncl, precedence: 1 }]
  : [];
const opsPolicies = [];
if (opsIncl.length) opsPolicies.push({ name: "esp operators (service)", decision: "non_identity", include: opsIncl, precedence: 1 });
if (EMAILS.length)
  opsPolicies.push({ name: "esp operators (people)", decision: "allow", include: EMAILS.map((email) => ({ email: { email } })), precedence: 2 });

const deviceAud = await ensure("esp-hub-device", "device", devicePolicies);
const opsAud = await ensure("esp-hub-ops", "ops", opsPolicies);
console.error(`device tokens=${deviceIncl.length} ops tokens=${opsIncl.length} emails=${EMAILS.length}`);
console.log(`DEVICE_AUD=${deviceAud}`);
console.log(`OPS_AUD=${opsAud}`);
