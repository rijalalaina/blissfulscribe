/**
 * BlissfulScribe Licence Worker
 * ──────────────────────────────
 * Endpoints
 *   POST /webhook    — Stripe checkout.session.completed → generate key → email
 *   POST /validate   — App validates key (+ optional activation check)
 *   POST /activate   — App activates key on a device
 *   POST /deactivate — App / portal deactivates a device
 *   GET  /portal     — Customer self-service HTML portal
 *
 * Environment (secrets via wrangler secret put):
 *   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks
 *   RESEND_API_KEY         — from resend.com
 *   WORKER_API_KEY         — random string shared with the Mac app
 *
 * KV namespace binding: LICENCES
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface Env {
  LICENCES: KVNamespace;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  WORKER_API_KEY: string;
  ALLOWED_ORIGIN: string;
  STARTER_AMOUNT_CENTS: string;
  PRO_AMOUNT_CENTS: string;
  STARTER_MAX_ACTIVATIONS: string;
  PRO_MAX_ACTIVATIONS: string;
  FROM_EMAIL: string;
  SUPPORT_EMAIL: string;
  PORTAL_URL: string;
  APP_NAME: string;
}

interface Activation {
  id: string;
  deviceId: string;
  deviceName: string;
  activatedAt: string;
}

interface LicenceRecord {
  key: string;
  email: string;
  name: string;
  maxActivations: number;
  product: "starter" | "pro";
  createdAt: string;
  stripeSessionId: string;
  activations: Activation[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** Generates a key in the format BSCRB-XXXXX-XXXXX-XXXXX-XXXXX */
function generateLicenceKey(): string {
  // Charset excludes I, O, 0, 1 to avoid visual confusion
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let i = 0; i < 5; i++) {
      group += chars[bytes[g * 5 + i] % chars.length];
    }
    groups.push(group);
  }
  return `BSCRB-${groups.join("-")}`;
}

/** HMAC-SHA256 signature verification for Stripe webhooks */
async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  const parts = signatureHeader.split(",");
  const ts = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v1 = parts.find((p) => p.startsWith("v1="))?.slice(3);
  if (!ts || !v1) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${ts}.${rawBody}`)
  );
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return computed === v1;
}

/** Constant-time string compare (mitigate timing attacks) */
async function safeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  const ka = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("compare"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign("HMAC", ka, new TextEncoder().encode(a)),
    crypto.subtle.sign("HMAC", ka, new TextEncoder().encode(b)),
  ]);
  const ua = new Uint8Array(sa), ub = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

/** Read and parse a LicenceRecord from KV, or null */
async function getLicence(kv: KVNamespace, key: string): Promise<LicenceRecord | null> {
  const raw = await kv.get(`licence:${key.toUpperCase()}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as LicenceRecord; } catch { return null; }
}

/** Write a LicenceRecord back to KV */
async function putLicence(kv: KVNamespace, record: LicenceRecord): Promise<void> {
  await kv.put(`licence:${record.key}`, JSON.stringify(record));
}

/** Send licence key email via Resend */
async function sendLicenceEmail(
  env: Env,
  email: string,
  name: string,
  licenceKey: string,
  product: "starter" | "pro",
  maxActivations: number
): Promise<void> {
  const productLabel = product === "pro"
    ? `Pro (${maxActivations} Macs)`
    : `Starter (${maxActivations} Mac)`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a}
  .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .hdr{background:linear-gradient(135deg,#2563eb,#0d9488);padding:36px 32px;text-align:center}
  .hdr h1{margin:0;color:#fff;font-size:22px;font-weight:700}
  .hdr p{margin:8px 0 0;color:rgba(255,255,255,.85);font-size:15px}
  .body{padding:32px}
  .key-box{background:#f0f9ff;border:2px dashed #93c5fd;border-radius:12px;padding:24px;text-align:center;margin:24px 0}
  .key{font-family:'Courier New',monospace;font-size:20px;font-weight:700;color:#1d4ed8;letter-spacing:3px;word-break:break-all}
  .steps{background:#f8fafc;border-radius:10px;padding:20px 20px 20px 36px;margin:20px 0}
  .steps li{margin:8px 0;font-size:15px;color:#334155}
  .btn{display:inline-block;background:linear-gradient(135deg,#2563eb,#0d9488);color:#fff;text-decoration:none;padding:14px 28px;border-radius:9px;font-weight:600;font-size:15px;margin:8px 0}
  .footer{background:#f8fafc;padding:20px 32px;text-align:center;color:#64748b;font-size:13px;border-top:1px solid #e2e8f0}
  .footer a{color:#2563eb;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>🎉 Your BlissfulScribe licence is ready</h1>
    <p>Thank you for purchasing ${env.APP_NAME} ${productLabel}</p>
  </div>
  <div class="body">
    <p>Hi ${name ? name.split(" ")[0] : "there"},</p>
    <p>Your payment was successful. Here is your licence key — <strong>keep this email safe</strong>:</p>
    <div class="key-box">
      <div style="font-size:12px;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Your Licence Key</div>
      <div class="key">${licenceKey}</div>
    </div>
    <h3 style="margin:24px 0 12px">How to activate</h3>
    <ol class="steps">
      <li>Open <strong>BlissfulScribe</strong> on your Mac</li>
      <li>Click the menu bar icon → <strong>Settings → Licence</strong></li>
      <li>Paste the key above and click <strong>Activate</strong></li>
    </ol>
    <p style="color:#64748b;font-size:14px">This licence allows activation on <strong>${maxActivations} Mac${maxActivations > 1 ? "s" : ""}</strong>. To manage your activations (e.g. switch to a new Mac) visit the link below.</p>
    <div style="text-align:center;margin:28px 0">
      <a class="btn" href="${env.PORTAL_URL}?key=${licenceKey}">Manage My Activations</a>
    </div>
    <p style="color:#64748b;font-size:14px">Questions? Email us at <a href="mailto:${env.SUPPORT_EMAIL}" style="color:#2563eb">${env.SUPPORT_EMAIL}</a> — we reply within 24 hours.</p>
    <p>Enjoy BlissfulScribe!<br><strong>The Blissfulplan Team</strong></p>
  </div>
  <div class="footer">
    <p>Blissfulplan Publishing Ltd. · London, UK</p>
    <p><a href="https://tryscribe.blissfulplan.com">tryscribe.blissfulplan.com</a> · <a href="mailto:${env.SUPPORT_EMAIL}">${env.SUPPORT_EMAIL}</a></p>
    <p style="margin-top:8px;color:#94a3b8">30-day money-back guarantee. To request a refund email us with your order details.</p>
  </div>
</div>
</body>
</html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: email,
      subject: `Your BlissfulScribe Licence Key (${productLabel})`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Resend error ${res.status}: ${body}`);
  }
}

/** Simple customer self-service portal HTML */
function portalHtml(record: LicenceRecord | null, key: string, env: Env): string {
  const activationRows = record
    ? record.activations
        .map(
          (a) => `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0">${a.deviceName}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px">${new Date(a.activatedAt).toLocaleDateString()}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0">
          <form method="POST" action="/deactivate" style="margin:0">
            <input type="hidden" name="key" value="${record!.key}">
            <input type="hidden" name="activationId" value="${a.id}">
            <input type="hidden" name="source" value="portal">
            <button type="submit" style="background:#fee2e2;color:#dc2626;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px">Deactivate</button>
          </form>
        </td>
      </tr>`
        )
        .join("")
    : "";

  const info = record
    ? `<p style="color:#475569">Licence: <strong>${record.key}</strong> &nbsp;·&nbsp; ${record.product === "pro" ? "Pro" : "Starter"} &nbsp;·&nbsp; ${record.activations.length} / ${record.maxActivations} activations used</p>`
    : `<p style="color:#dc2626">Licence key not found. Check the key and try again.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manage Licence · BlissfulScribe</title>
<style>
  *{box-sizing:border-box}body{margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a}
  .nav{background:linear-gradient(135deg,#2563eb,#0d9488);padding:16px 24px;display:flex;align-items:center;gap:12px}
  .nav strong{color:#fff;font-size:18px}
  .container{max-width:680px;margin:48px auto;padding:0 24px}
  h1{font-size:26px;font-weight:700;margin:0 0 8px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;margin:24px 0;box-shadow:0 1px 4px rgba(0,0,0,.04)}
  .form-row{display:flex;gap:12px;margin-bottom:0}
  input[type=text]{flex:1;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;font-family:monospace}
  button.primary{background:linear-gradient(135deg,#2563eb,#0d9488);color:#fff;border:none;padding:11px 22px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  table{width:100%;border-collapse:collapse}
  th{padding:10px 16px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;background:#f8fafc;border-bottom:2px solid #e2e8f0}
  a{color:#2563eb}
</style>
</head>
<body>
<div class="nav"><strong>BlissfulScribe</strong> <span style="color:rgba(255,255,255,.7);font-size:14px">Licence Manager</span></div>
<div class="container">
  <h1>Manage Licence</h1>
  <p style="color:#64748b">Enter your licence key to view and manage your device activations.</p>
  <div class="card">
    <form method="GET" action="/portal">
      <div class="form-row">
        <input type="text" name="key" placeholder="BSCRB-XXXXX-XXXXX-XXXXX-XXXXX" value="${key || ""}" required>
        <button type="submit" class="primary">Look up</button>
      </div>
    </form>
  </div>
  ${
    record
      ? `<div class="card">
    ${info}
    ${
      record.activations.length > 0
        ? `<table>
        <thead><tr><th>Device</th><th>Activated</th><th>Action</th></tr></thead>
        <tbody>${activationRows}</tbody>
      </table>`
        : `<p style="color:#64748b;margin:0">No active devices. <a href="${env.PORTAL_URL}">Look up another key</a></p>`
    }
  </div>`
      : key
      ? `<div class="card">${info}</div>`
      : ""
  }
  <p style="color:#94a3b8;font-size:13px;margin-top:32px">Need help? Email <a href="mailto:${env.SUPPORT_EMAIL}">${env.SUPPORT_EMAIL}</a></p>
</div>
</body>
</html>`;
}

// ── Route Handlers ───────────────────────────────────────────────────────────

/** POST /webhook — Stripe sends checkout.session.completed */
async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const sig = request.headers.get("stripe-signature") ?? "";

  const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return err("Invalid signature", 400);

  let event: { type: string; data: { object: Record<string, unknown> } };
  try { event = JSON.parse(rawBody); } catch { return err("Invalid JSON", 400); }

  if (event.type !== "checkout.session.completed") {
    return new Response("Ignored", { status: 200 });
  }

  const session = event.data.object;
  const sessionId = session.id as string;
  const email = (session.customer_details as Record<string, string> | null)?.email ?? "";
  const name = (session.customer_details as Record<string, string> | null)?.name ?? "";
  const amountTotal = (session.amount_total as number) ?? 0;

  if (!email) {
    console.error("No customer email in session", sessionId);
    return new Response("No email", { status: 200 }); // acknowledge to Stripe
  }

  // Idempotency: if we already issued a key for this session, resend email only
  const existingKeyRef = await env.LICENCES.get(`session:${sessionId}`);
  if (existingKeyRef) {
    const existing = await getLicence(env.LICENCES, existingKeyRef);
    if (existing) {
      console.log(`Duplicate webhook for session ${sessionId}, resending email`);
      await sendLicenceEmail(env, email, name, existing.key, existing.product, existing.maxActivations);
      return new Response("OK", { status: 200 });
    }
  }

  // Determine product tier from amount
  const starterCents = parseInt(env.STARTER_AMOUNT_CENTS, 10);
  const proCents = parseInt(env.PRO_AMOUNT_CENTS, 10);
  let product: "starter" | "pro";
  let maxActivations: number;

  if (amountTotal >= proCents) {
    product = "pro";
    maxActivations = parseInt(env.PRO_MAX_ACTIVATIONS, 10);
  } else if (amountTotal >= starterCents) {
    product = "starter";
    maxActivations = parseInt(env.STARTER_MAX_ACTIVATIONS, 10);
  } else {
    console.error(`Unknown amount ${amountTotal} cents for session ${sessionId}`);
    return new Response("Unknown product", { status: 200 });
  }

  // Generate unique key (retry on the tiny chance of collision)
  let licenceKey: string;
  for (let attempt = 0; attempt < 5; attempt++) {
    licenceKey = generateLicenceKey();
    const existing = await env.LICENCES.get(`licence:${licenceKey}`);
    if (!existing) break;
  }

  const record: LicenceRecord = {
    key: licenceKey!,
    email,
    name,
    maxActivations,
    product,
    createdAt: new Date().toISOString(),
    stripeSessionId: sessionId,
    activations: [],
  };

  // Store in KV
  await putLicence(env.LICENCES, record);
  await env.LICENCES.put(`session:${sessionId}`, record.key);

  // Send email
  await sendLicenceEmail(env, email, name, record.key, product, maxActivations);

  console.log(`Issued licence ${record.key} (${product}) for ${email}`);
  return new Response("OK", { status: 200 });
}

/** POST /validate — App checks if a key is valid (optionally with activationId) */
async function handleValidate(request: Request, env: Env): Promise<Response> {
  const apiKey = request.headers.get("X-API-Key") ?? "";
  if (!(await safeEqual(apiKey, env.WORKER_API_KEY))) return err("Unauthorised", 401);

  const body = await request.json() as { key?: string; activationId?: string };
  const key = body.key?.trim().toUpperCase();
  if (!key) return err("Missing key", 400);

  const record = await getLicence(env.LICENCES, key);
  if (!record) return err("Key not found", 404);

  // If activationId provided, check it still exists
  if (body.activationId) {
    const found = record.activations.find((a) => a.id === body.activationId);
    return json({
      valid: !!found,
      maxActivations: record.maxActivations,
      activations: record.activations,
    });
  }

  return json({
    valid: true,
    maxActivations: record.maxActivations,
    activations: record.activations,
  });
}

/** POST /activate — App registers a device against a key */
async function handleActivate(request: Request, env: Env): Promise<Response> {
  const apiKey = request.headers.get("X-API-Key") ?? "";
  if (!(await safeEqual(apiKey, env.WORKER_API_KEY))) return err("Unauthorised", 401);

  const body = await request.json() as { key?: string; deviceId?: string; deviceName?: string };
  const key = body.key?.trim().toUpperCase();
  const deviceId = body.deviceId?.trim();
  const deviceName = body.deviceName?.trim() ?? "Unknown Mac";

  if (!key || !deviceId) return err("Missing key or deviceId", 400);

  const record = await getLicence(env.LICENCES, key);
  if (!record) return err("Key not found", 404);

  // If device already activated, return existing activationId (idempotent)
  const existing = record.activations.find((a) => a.deviceId === deviceId);
  if (existing) {
    return json({ activationId: existing.id, maxActivations: record.maxActivations });
  }

  // Check capacity
  if (record.activations.length >= record.maxActivations) {
    return err("Activation limit reached", 403);
  }

  // Create new activation
  const activation: Activation = {
    id: crypto.randomUUID(),
    deviceId,
    deviceName,
    activatedAt: new Date().toISOString(),
  };
  record.activations.push(activation);
  await putLicence(env.LICENCES, record);

  return json({ activationId: activation.id, maxActivations: record.maxActivations });
}

/** POST /deactivate — Remove a device activation (from app or portal) */
async function handleDeactivate(request: Request, env: Env): Promise<Response> {
  // Accept both JSON (from app) and form-encoded (from portal HTML form)
  const ct = request.headers.get("Content-Type") ?? "";
  let key: string | undefined;
  let activationId: string | undefined;
  let fromPortal = false;

  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    key = (form.get("key") as string)?.trim().toUpperCase();
    activationId = (form.get("activationId") as string)?.trim();
    fromPortal = form.get("source") === "portal";
  } else {
    const apiKey = request.headers.get("X-API-Key") ?? "";
    if (!(await safeEqual(apiKey, env.WORKER_API_KEY))) return err("Unauthorised", 401);
    const body = await request.json() as { key?: string; activationId?: string };
    key = body.key?.trim().toUpperCase();
    activationId = body.activationId?.trim();
  }

  if (!key || !activationId) return err("Missing key or activationId", 400);

  const record = await getLicence(env.LICENCES, key);
  if (!record) return fromPortal
    ? new Response("Key not found", { status: 404, headers: { Location: `/portal?key=${key}&error=not_found` } })
    : err("Key not found", 404);

  const before = record.activations.length;
  record.activations = record.activations.filter((a) => a.id !== activationId);
  if (record.activations.length === before) return fromPortal
    ? Response.redirect(`/portal?key=${key}&error=not_found`, 302)
    : err("Activation not found", 404);

  await putLicence(env.LICENCES, record);

  if (fromPortal) {
    return Response.redirect(`/portal?key=${key}&success=deactivated`, 302);
  }
  return json({ success: true });
}

/** GET /portal — Customer self-service page */
async function handlePortal(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key")?.trim().toUpperCase() ?? "";
  const record = key ? await getLicence(env.LICENCES, key) : null;
  const html = portalHtml(record, key, env);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
        },
      });
    }

    try {
      if (url.pathname === "/webhook" && method === "POST") return handleWebhook(request, env);
      if (url.pathname === "/validate" && method === "POST") return handleValidate(request, env);
      if (url.pathname === "/activate" && method === "POST") return handleActivate(request, env);
      if (url.pathname === "/deactivate") return handleDeactivate(request, env);
      if (url.pathname === "/portal" && method === "GET") return handlePortal(request, env);
      if (url.pathname === "/health" && method === "GET") return new Response("OK");
      return err("Not found", 404);
    } catch (e) {
      console.error("Unhandled error:", e);
      return err("Internal server error", 500);
    }
  },
};
