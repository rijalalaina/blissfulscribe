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
  isAdmin?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
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
      isAdmin: record.isAdmin ?? false,
    });
  }

  return json({
    valid: true,
    maxActivations: record.maxActivations,
    activations: record.activations,
    isAdmin: record.isAdmin ?? false,
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

  // Send confirmation email (fire-and-forget; don't block the response)
  if (record.email) {
    const productLabel = record.product === "pro"
      ? `Pro (${record.maxActivations} Macs)`
      : `Starter (${record.maxActivations} Mac)`;
    const confirmHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:-apple-system,sans-serif;background:#f8fafc;margin:0;padding:0;color:#0f172a}
.wrap{max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.hdr{background:linear-gradient(135deg,#2563eb,#0d9488);padding:28px 32px;text-align:center}
.hdr h1{margin:0;color:#fff;font-size:20px;font-weight:700}
.body{padding:28px 32px}
.info{background:#f0fdf4;border-left:4px solid #22c55e;border-radius:8px;padding:14px 16px;margin:16px 0}
.footer{background:#f8fafc;padding:16px 32px;text-align:center;color:#94a3b8;font-size:13px;border-top:1px solid #e2e8f0}
a{color:#2563eb}</style></head><body>
<div class="wrap">
  <div class="hdr"><h1>✅ BlissfulScribe is now activated</h1></div>
  <div class="body">
    <p>Your <strong>${productLabel}</strong> licence was successfully activated on <strong>${deviceName}</strong>.</p>
    <div class="info">
      <strong>Licence key:</strong> <code>${record.key}</code><br>
      <strong>Device:</strong> ${deviceName}<br>
      <strong>Activations used:</strong> ${record.activations.length} / ${record.maxActivations}
    </div>
    <p style="color:#64748b;font-size:14px">Need to switch to a new Mac or manage your activations?
      <a href="${env.PORTAL_URL}?key=${record.key}">Visit the licence portal</a>.</p>
    <p style="color:#64748b;font-size:14px">Questions? <a href="mailto:${env.SUPPORT_EMAIL}">${env.SUPPORT_EMAIL}</a></p>
  </div>
  <div class="footer">Blissfulplan Publishing Ltd. · London, UK</div>
</div></body></html>`;

    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: record.email,
        subject: `BlissfulScribe activated on ${deviceName}`,
        html: confirmHtml,
      }),
    }).catch((e) => console.error("Activation email error:", e));
  }

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

// ── Trial drip email system ──────────────────────────────────────────────────

interface TrialRecord {
  email: string;
  startedAt: string;   // ISO timestamp
  sentDays: number[];  // e.g. [2, 5] — which day emails have already been sent
}

/** POST /trial-start — App calls this when user starts the free trial */
async function handleTrialStart(request: Request, env: Env): Promise<Response> {
  const apiKey = request.headers.get("X-API-Key") ?? "";
  if (!(await safeEqual(apiKey, env.WORKER_API_KEY))) return err("Unauthorised", 401);

  const body = await request.json() as { email?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return err("Valid email required", 400);

  // Idempotent: don't overwrite if already registered
  const existing = await env.LICENCES.get(`trial:${email}`);
  if (!existing) {
    const record: TrialRecord = { email, startedAt: new Date().toISOString(), sentDays: [] };
    await env.LICENCES.put(`trial:${email}`, JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24 * 60, // auto-expire after 60 days
    });
    console.log(`Trial started for ${email}`);
  }
  return json({ ok: true });
}

/** Sends a drip email. Returns true on success. */
async function sendDripEmail(
  env: Env,
  email: string,
  day: number
): Promise<boolean> {
  const subjects: Record<number, string> = {
    2: "3 tips to get more out of BlissfulScribe",
    5: `You have ${20 - (await (async () => 0)())} free transcriptions left`,
    7: "Your BlissfulScribe free trial is ending soon",
  };
  const bodies: Record<number, string> = {
    2: `<p>Hi there,</p>
<p>You started your BlissfulScribe free trial a couple of days ago. Here are three tips to get the most out of it:</p>
<ol>
<li><strong>Set a global hotkey</strong> — go to Settings → Shortcuts and bind a key. One press to start, one to stop.</li>
<li><strong>Try AI Enhancement</strong> — go to AI Models, connect an API key (OpenAI or Gemini), then enable Enhancement in your Mode. It cleans up filler words and fixes grammar automatically.</li>
<li><strong>Use Modes</strong> — create different profiles for writing, coding, or emails. Each can use a different transcription model and enhancement style.</li>
</ol>
<p>Questions? Reply to this email — we read every message.</p>`,
    5: `<p>Hi there,</p>
<p>You're over halfway through your BlissfulScribe free trial. We hope it's been useful!</p>
<p>If you've found BlissfulScribe valuable, now is a great time to pick up a licence before your trial ends. You'll keep all your history, modes, and settings — nothing resets.</p>
<ul>
<li><strong>Starter</strong> — $9.99 one-time, 1 Mac, lifetime updates</li>
<li><strong>Pro</strong> — $19.99 one-time, 3 Macs, priority support</li>
</ul>
<div style="text-align:center;margin:24px 0"><a href="https://scribe.blissfulplan.com/#pricing" style="background:linear-gradient(135deg,#2563eb,#0d9488);color:#fff;padding:12px 28px;border-radius:9px;text-decoration:none;font-weight:600">View Pricing →</a></div>`,
    7: `<p>Hi there,</p>
<p>Your BlissfulScribe free trial is ending today. Once your 20 free transcriptions are used up, recording will pause until you activate a licence.</p>
<p>Upgrade now to keep your workflow uninterrupted:</p>
<div style="text-align:center;margin:24px 0"><a href="https://scribe.blissfulplan.com/#pricing" style="background:linear-gradient(135deg,#2563eb,#0d9488);color:#fff;padding:12px 28px;border-radius:9px;text-decoration:none;font-weight:600">Upgrade BlissfulScribe →</a></div>
<p style="color:#64748b;font-size:14px">30-day money-back guarantee · One-time payment · No subscription</p>`,
  };

  const subject = subjects[day] ?? `Day ${day} — BlissfulScribe`;
  const body = bodies[day] ?? "<p>Thank you for trying BlissfulScribe.</p>";

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:-apple-system,sans-serif;background:#f8fafc;margin:0;color:#0f172a}
.wrap{max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.hdr{background:linear-gradient(135deg,#2563eb,#0d9488);padding:20px 28px}
.hdr strong{color:#fff;font-size:18px;font-weight:700}
.body{padding:24px 28px;line-height:1.65}ol,ul{padding-left:20px}li{margin:6px 0}
.footer{background:#f8fafc;padding:14px 28px;text-align:center;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0}
a{color:#2563eb}</style></head><body>
<div class="wrap">
  <div class="hdr"><strong>BlissfulScribe</strong></div>
  <div class="body">${body}
    <p style="margin-top:24px;color:#64748b;font-size:13px">— The Blissfulplan Team<br>
    <a href="mailto:${env.SUPPORT_EMAIL}">${env.SUPPORT_EMAIL}</a></p>
  </div>
  <div class="footer">Blissfulplan Publishing Ltd. · London, UK<br>
  <a href="https://scribe.blissfulplan.com/unsubscribe?email=${encodeURIComponent(email)}">Unsubscribe</a></div>
</div></body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: email, subject, html }),
  });
  return res.ok;
}

/** Scheduled handler — runs daily via Cloudflare Cron.
 *  Iterates trial records and sends Day 2 / 5 / 7 drip emails. */
async function handleScheduled(env: Env): Promise<void> {
  const drip = [2, 5, 7];
  const list = await env.LICENCES.list({ prefix: "trial:" });

  for (const key of list.keys) {
    const raw = await env.LICENCES.get(key.name);
    if (!raw) continue;

    let record: TrialRecord;
    try { record = JSON.parse(raw); } catch { continue; }

    // Skip if already purchased a licence
    const hasPurchased = !!(await env.LICENCES.get(`licensed:${record.email}`));
    if (hasPurchased) continue;

    const daysSinceStart = Math.floor(
      (Date.now() - new Date(record.startedAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    for (const day of drip) {
      if (daysSinceStart >= day && !record.sentDays.includes(day)) {
        const ok = await sendDripEmail(env, record.email, day);
        if (ok) {
          record.sentDays.push(day);
          await env.LICENCES.put(key.name, JSON.stringify(record), {
            expirationTtl: 60 * 60 * 24 * 60,
          });
          console.log(`Drip day ${day} sent to ${record.email}`);
        }
        break; // send at most one email per run per user
      }
    }
  }
}

// ── Contact form handler ─────────────────────────────────────────────────────

/** POST /contact — Receives the website contact form and emails via Resend */
async function handleContact(request: Request, env: Env): Promise<Response> {
  // Accept both JSON and form-encoded (the HTML form posts multipart/form-data)
  const ct = request.headers.get("Content-Type") ?? "";
  let firstName = "", lastName = "", email = "", subject = "", message = "", botcheck = "";

  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await request.formData();
    firstName   = (form.get("firstName")  as string ?? "").trim();
    lastName    = (form.get("lastName")   as string ?? "").trim();
    email       = (form.get("email")      as string ?? "").trim();
    subject     = (form.get("subject")    as string ?? "General enquiry").trim();
    message     = (form.get("message")    as string ?? "").trim();
    botcheck    = (form.get("botcheck")   as string ?? "").trim();
  } else {
    const body  = await request.json() as Record<string, string>;
    firstName   = (body.firstName  ?? "").trim();
    lastName    = (body.lastName   ?? "").trim();
    email       = (body.email      ?? "").trim();
    subject     = (body.subject    ?? "General enquiry").trim();
    message     = (body.message    ?? "").trim();
    botcheck    = (body.botcheck   ?? "").trim();
  }

  // Honeypot — bots fill this field
  if (botcheck) return json({ ok: true }); // silently succeed to fool bots

  if (!email || !message) return err("Missing required fields", 400);

  const name = [firstName, lastName].filter(Boolean).join(" ") || email;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,sans-serif;color:#0f172a">
<h2 style="color:#2563eb">New contact message — BlissfulScribe</h2>
<table style="border-collapse:collapse;width:100%;max-width:560px">
  <tr><td style="padding:8px 0;color:#64748b;width:120px"><strong>From</strong></td><td>${name}</td></tr>
  <tr><td style="padding:8px 0;color:#64748b"><strong>Email</strong></td><td><a href="mailto:${email}">${email}</a></td></tr>
  <tr><td style="padding:8px 0;color:#64748b"><strong>Subject</strong></td><td>${subject}</td></tr>
</table>
<hr style="border:1px solid #e2e8f0;margin:16px 0">
<p style="white-space:pre-wrap;line-height:1.7">${message.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</p>
<hr style="border:1px solid #e2e8f0;margin:16px 0">
<p style="color:#94a3b8;font-size:12px">Sent via scribe.blissfulplan.com/contact</p>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [env.SUPPORT_EMAIL],
      reply_to: [email],
      subject: `[BlissfulScribe Contact] ${subject} — from ${name} <${email}>`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Contact email error ${res.status}: ${body}`);
    return err("Failed to send message", 500);
  }

  return json({ ok: true });
}

// ── Admin dashboard ──────────────────────────────────────────────────────────

function adminDashboardHtml(
  licences: LicenceRecord[],
  trials: { email: string; startedAt: string; sentDays: number[] }[],
  stats: { starterCount: number; proCount: number; revenue: number; totalDevices: number },
  adminKey: string,
  env: Env,
  message?: string
): string {
  const fmt = (n: number) => n.toLocaleString("en-GB");
  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
    catch { return iso.slice(0, 10); }
  };
  const fmtRev = (n: number) => `$${n.toFixed(2)}`;

  const licenceRows = licences
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => {
      const planBadge = r.product === "pro"
        ? `<span class="badge-pro">Pro</span>`
        : `<span class="badge-starter">Starter</span>`;
      const activRatio = `${r.activations.length} / ${r.maxActivations}`;
      const activeDevices = r.activations.map(a =>
        `<div style="font-size:11px;color:#94a3b8;padding:2px 0">${a.deviceName} · ${fmtDate(a.activatedAt)}</div>`
      ).join("");
      return `
        <tr>
          <td>${r.email || "<span style='color:#64748b'>—</span>"}</td>
          <td>${planBadge}</td>
          <td style="font-family:monospace;font-size:12px;color:#94a3b8">••••-${r.key.slice(-4)}</td>
          <td>
            <span style="font-weight:600">${activRatio}</span>
            ${activeDevices}
          </td>
          <td style="color:#64748b;font-size:13px">${fmtDate(r.createdAt)}</td>
          <td>
            <form method="POST" action="/admin/revoke?adminKey=${encodeURIComponent(adminKey)}" style="margin:0"
                  onsubmit="return confirm('Revoke licence for ${r.email}? This cannot be undone.')">
              <input type="hidden" name="licenceKey" value="${r.key}">
              <button type="submit" class="btn-revoke">Revoke</button>
            </form>
          </td>
        </tr>`;
    }).join("");

  const trialRows = trials
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(t => `
      <tr>
        <td>${t.email}</td>
        <td style="color:#64748b;font-size:13px">${fmtDate(t.startedAt)}</td>
        <td>
          ${t.sentDays.length === 0
            ? `<span style="color:#94a3b8">None yet</span>`
            : t.sentDays.map(d => `<span class="day-pill">Day ${d}</span>`).join(" ")}
        </td>
      </tr>`).join("");

  const alertHtml = message
    ? `<div class="alert">${message}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Dashboard · BlissfulScribe</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px}
    .topbar{background:linear-gradient(135deg,#2563eb,#0d9488);padding:14px 24px;display:flex;align-items:center;gap:12px}
    .topbar-brand{color:#fff;font-size:17px;font-weight:700}
    .topbar-label{color:rgba(255,255,255,.7);font-size:12px;background:rgba(255,255,255,.15);padding:3px 10px;border-radius:999px}
    .container{max-width:1100px;margin:0 auto;padding:28px 20px}
    h2{font-size:15px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:32px}
    .stat{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px 20px}
    .stat-val{font-size:28px;font-weight:800;background:linear-gradient(135deg,#60a5fa,#34d399);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .stat-label{font-size:12px;color:#64748b;margin-top:4px}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden;margin-bottom:28px}
    .card-hdr{padding:14px 20px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between}
    .card-hdr-title{font-size:15px;font-weight:600}
    .card-hdr-count{font-size:12px;color:#64748b;background:#0f172a;padding:3px 10px;border-radius:999px}
    table{width:100%;border-collapse:collapse}
    th{padding:10px 16px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;background:#0f172a;border-bottom:1px solid #334155}
    td{padding:11px 16px;border-bottom:1px solid #1e293b;vertical-align:top}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:rgba(255,255,255,.02)}
    .badge-pro{background:linear-gradient(135deg,#2563eb,#0d9488);color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}
    .badge-starter{background:#334155;color:#94a3b8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}
    .btn-revoke{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}
    .btn-revoke:hover{background:#7f1d1d}
    .day-pill{background:#1e40af;color:#bfdbfe;font-size:11px;padding:2px 7px;border-radius:999px}
    .empty{padding:28px;text-align:center;color:#475569}
    .alert{background:#14532d;border:1px solid #166534;color:#86efac;padding:12px 18px;border-radius:8px;margin-bottom:20px}
  </style>
</head>
<body>
<div class="topbar">
  <span class="topbar-brand">BlissfulScribe</span>
  <span class="topbar-label">Admin Dashboard</span>
</div>
<div class="container">
  ${alertHtml}
  <div class="stats">
    <div class="stat">
      <div class="stat-val">${fmt(licences.length)}</div>
      <div class="stat-label">Total licences sold</div>
    </div>
    <div class="stat">
      <div class="stat-val">${fmt(stats.starterCount)}</div>
      <div class="stat-label">Starter ($9.99)</div>
    </div>
    <div class="stat">
      <div class="stat-val">${fmt(stats.proCount)}</div>
      <div class="stat-label">Pro ($19.99)</div>
    </div>
    <div class="stat">
      <div class="stat-val">${fmtRev(stats.revenue)}</div>
      <div class="stat-label">Est. gross revenue</div>
    </div>
    <div class="stat">
      <div class="stat-val">${fmt(stats.totalDevices)}</div>
      <div class="stat-label">Active devices</div>
    </div>
    <div class="stat">
      <div class="stat-val">${fmt(trials.length)}</div>
      <div class="stat-label">Trial users</div>
    </div>
  </div>

  <div class="card">
    <div class="card-hdr">
      <span class="card-hdr-title">Licence Keys</span>
      <span class="card-hdr-count">${licences.length} total</span>
    </div>
    ${licences.length === 0
      ? `<div class="empty">No licences issued yet.</div>`
      : `<table>
        <thead><tr>
          <th>Email</th><th>Plan</th><th>Key</th><th>Activations</th><th>Issued</th><th>Action</th>
        </tr></thead>
        <tbody>${licenceRows}</tbody>
      </table>`}
  </div>

  <div class="card">
    <div class="card-hdr">
      <span class="card-hdr-title">Trial Users (drip sequence)</span>
      <span class="card-hdr-count">${trials.length} registered</span>
    </div>
    ${trials.length === 0
      ? `<div class="empty">No trial email registrations yet.</div>`
      : `<table>
        <thead><tr>
          <th>Email</th><th>Trial started</th><th>Drip emails sent</th>
        </tr></thead>
        <tbody>${trialRows}</tbody>
      </table>`}
  </div>

  <p style="color:#334155;font-size:12px;text-align:center;margin-top:8px">
    Data is live from Cloudflare KV · Refresh the page to update
  </p>
</div>
</body>
</html>`;
}

/** GET /admin — Owner-only analytics dashboard */
async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key")?.trim().toUpperCase();

  if (!key) {
    return new Response("Admin key required. Append ?key=YOUR_ADMIN_KEY", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const record = await getLicence(env.LICENCES, key);
  if (!record?.isAdmin) {
    return new Response("Unauthorized", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Gather all licence records (excluding admin key itself)
  const licenceList = await env.LICENCES.list({ prefix: "licence:" });
  const licenceRecords: LicenceRecord[] = [];
  for (const k of licenceList.keys) {
    const raw = await env.LICENCES.get(k.name);
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as LicenceRecord;
      if (!r.isAdmin) licenceRecords.push(r);
    } catch { /* skip malformed */ }
  }

  // Gather trial records
  const trialList = await env.LICENCES.list({ prefix: "trial:" });
  const trialRecords: { email: string; startedAt: string; sentDays: number[] }[] = [];
  for (const k of trialList.keys) {
    const raw = await env.LICENCES.get(k.name);
    if (!raw) continue;
    try { trialRecords.push(JSON.parse(raw)); } catch { /* skip */ }
  }

  const starterCount = licenceRecords.filter(r => r.product === "starter").length;
  const proCount = licenceRecords.filter(r => r.product === "pro").length;
  const revenue = starterCount * 9.99 + proCount * 19.99;
  const totalDevices = licenceRecords.reduce((sum, r) => sum + r.activations.length, 0);

  const successMsg = url.searchParams.get("success")
    ? `Licence ${url.searchParams.get("licence") ?? ""} has been revoked.`
    : undefined;

  const html = adminDashboardHtml(
    licenceRecords, trialRecords,
    { starterCount, proCount, revenue, totalDevices },
    key, env, successMsg
  );

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** POST /admin/revoke — Revoke a licence key (admin only) */
async function handleAdminRevoke(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const adminKey = url.searchParams.get("adminKey")?.trim().toUpperCase();

  const adminRecord = adminKey ? await getLicence(env.LICENCES, adminKey) : null;
  if (!adminRecord?.isAdmin) {
    return new Response("Unauthorized", { status: 403, headers: { "Content-Type": "text/plain" } });
  }

  const form = await request.formData();
  const licenceKey = (form.get("licenceKey") as string | null)?.trim().toUpperCase();
  if (!licenceKey) return new Response("Missing licenceKey", { status: 400 });

  await env.LICENCES.delete(`licence:${licenceKey}`);

  const encodedKey = encodeURIComponent(adminKey);
  return Response.redirect(
    `${url.origin}/admin?key=${encodedKey}&success=1&licence=${licenceKey}`,
    302
  );
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
          "Access-Control-Allow-Origin": "*",
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
      if (url.pathname === "/trial-start" && method === "POST") return handleTrialStart(request, env);
      if (url.pathname === "/contact" && method === "POST") return handleContact(request, env);
      if (url.pathname === "/admin" && method === "GET") return handleAdmin(request, env);
      if (url.pathname === "/admin/revoke" && method === "POST") return handleAdminRevoke(request, env);
      if (url.pathname === "/health" && method === "GET") return new Response("OK");
      return err("Not found", 404);
    } catch (e) {
      console.error("Unhandled error:", e);
      return err("Internal server error", 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(env);
  },
};
