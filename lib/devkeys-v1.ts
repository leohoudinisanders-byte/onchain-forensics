// devKeys - free developer keys for the cached verdict tier.
//
// WHY (Nov 6, 2026): nobody wires a per-call payment signature into a prototype. The paid x402
// path stays for production traffic and the free trial stays for one-off curiosity, but a builder
// who wants to call 500 times while shipping needs a key that just works. This issues one key per
// email, 10,000 calls per calendar month, no card, no payment, capped so it cannot be farmed:
// one key per email and one per IP per day.
//
// The plaintext key is shown ONCE. Only its SHA-256 hash is stored (CreditsAccount.key_hash,
// plan dev_free_10k, quota_month/quota_used for the monthly cap), so a lost key means a new email.
//
// POST {email}                     -> {key, plan, quota}
// POST {action:"status"} + X-Dev-Key -> current quota, masked email
// GET  ?action=info                -> free tier terms, no auth

import { createClientFromRequest } from "npm:@base44/sdk@0.8.54";

const CAP = 10000;
const PLAN = "dev_free_10k";
const SERVICE = "onchain-forensics-devkeys";

function jsonResp(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

function newKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "fxk_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validEmail(e: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e) && e.length <= 200;
}

function maskEmail(e: string): string {
  const [u, d] = String(e || "").split("@");
  if (!d) return "";
  const head = u.slice(0, 2);
  return `${head}${"*".repeat(Math.max(2, u.length - 2))}@${d}`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const base44 = createClientFromRequest(req);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

  if (req.method === "OPTIONS") return jsonResp({ ok: true });
  if (url.searchParams.get("action") === "info" || req.method === "GET") {
    return jsonResp({
      service: SERVICE,
      plan: PLAN,
      quota: { calls_per_month: CAP, cost: "$0.00", card_required: false },
      covers: ["cached verdict tier (/functions/verdictFast), any token in the hourly feed"],
      how_to_call: { header: "X-Dev-Key: fxk_...", note: "no payment signature, no trial parameter" },
      how_to_get: "POST this URL with {\"email\":\"you@example.com\"}",
      limits: { keys_per_email: 1, keys_per_ip_per_day: 1, quota_resets: "1st of each month, UTC" },
      upgrade: "Prepaid packs remove the cap: POST /functions/forensicsCredits {\"plan\":\"pack25\"}",
    });
  }

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  // ---- status for an existing key ----
  const headerKey = (req.headers.get("x-dev-key") || "").trim();
  if (body.action === "status" || (headerKey && !body.email)) {
    if (!headerKey.startsWith("fxk_")) return jsonResp({ error: "missing_dev_key" }, 401);
    const hash = await sha256(headerKey);
    const rows: any[] = (await base44.asServiceRole.entities.CreditsAccount.filter({ key_hash: hash })) || [];
    const acct: any = rows[0];
    if (!acct) return jsonResp({ error: "invalid_dev_key" }, 401);
    const month = new Date().toISOString().slice(0, 7);
    const used = String(acct.quota_month || "") === month ? Number(acct.quota_used || 0) : 0;
    return jsonResp({
      service: SERVICE,
      plan: acct.plan || PLAN,
      status: acct.status || "active",
      email: maskEmail(String(acct.notes || "").replace("email=", "")),
      quota: { cap: CAP, used, remaining: Math.max(0, CAP - used), month, resets: `${month}-01T00:00:00Z` },
      calls_served_lifetime: Number(acct.calls_served || 0),
      last_used: acct.last_used_date || null,
    });
  }

  // ---- issue a key ----
  const email = String(body.email || "").trim().toLowerCase();
  if (!validEmail(email)) {
    return jsonResp({
      error: "missing_or_invalid_email",
      next: "POST {\"email\":\"you@example.com\"} to this URL. The key is emailed nowhere; it is returned once in this response, so store it.",
    }, 400);
  }

  // one key per IP per day, so a script cannot mint a thousand keys
  const today = new Date().toISOString().slice(0, 10);
  const ipKey = `devkey|${ip}|${today}`;
  try {
    const usage: any[] = (await base44.asServiceRole.entities.FreeCallUsage.list()) || [];
    const rec: any = usage.find((r: any) => (r.data?.usage_key ?? r.usage_key) === ipKey);
    if (rec && Number(rec?.data?.calls_used ?? rec?.calls_used ?? 0) >= 1) {
      return jsonResp({
        error: "one_key_per_caller_per_day",
        next: "Your key from today still works and is shown only once, so if you lost it, request again tomorrow or reply to onchainforensics and we will rotate it.",
      }, 429);
    }
  } catch (e) { console.error("devkey ip guard failed:", String(e)); }

  const hash = await sha256(email);
  const existing: any[] = (await base44.asServiceRole.entities.CreditsAccount.filter({ key_hash: hash })) || [];
  // email is stored hashed as key_hash; notes carries the visible email for support, not auth
  const emailRows: any[] = (await base44.asServiceRole.entities.CreditsAccount.filter({ notes: `email=${email}` })) || [];
  if (existing.length || emailRows.length) {
    return jsonResp({
      error: "key_already_issued_for_this_email",
      next: "One free key per email. Use the key you already have, check its quota with {\"action\":\"status\"} and the X-Dev-Key header, or buy a prepaid pack for higher volume.",
    }, 409);
  }

  const key = newKey();
  const keyHash = await sha256(key);
  const month = new Date().toISOString().slice(0, 7);
  try {
    await base44.asServiceRole.entities.CreditsAccount.create({
      key_hash: keyHash,
      key_prefix: key.slice(0, 12),
      plan: PLAN,
      price_usd: 0,
      initial_credit_micro_usd: 0,
      balance_micro_usd: 0,
      calls_served: 0,
      status: "active",
      quota_month: month,
      quota_used: 0,
      last_used_date: new Date().toISOString(),
      notes: `email=${email}`,
    });
  } catch (e) {
    return jsonResp({ error: "key_storage_failed", detail: String(e).slice(0, 160) }, 500);
  }

  try {
    const payload = { usage_key: ipKey, calls_used: 1 };
    const usage: any[] = (await base44.asServiceRole.entities.FreeCallUsage.list()) || [];
    const rec: any = usage.find((r: any) => (r.data?.usage_key ?? r.usage_key) === ipKey);
    if (rec) await base44.asServiceRole.entities.FreeCallUsage.update(rec.id, payload);
    else await base44.asServiceRole.entities.FreeCallUsage.create(payload);
  } catch (e) { console.error("devkey ip accounting failed:", String(e)); }

  return jsonResp({
    service: SERVICE,
    key,
    key_prefix: key.slice(0, 12),
    plan: PLAN,
    quota: { cap: CAP, used: 0, remaining: CAP, month, resets: `${month}-01T00:00:00Z` },
    store_it_now: "This key is returned once and stored only as a hash. Keep it in an env var.",
    how_to_call: {
      curl: `curl -H "X-Dev-Key: ${key}" "https://api.onchainforensics.dev/functions/verdictFast?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&chain=base"`,
      header: "X-Dev-Key",
      note: "No payment signature and no trial parameter needed. Cache misses do not count against the quota.",
    },
    upgrade: "Above 10,000/month: POST /functions/forensicsCredits {\"plan\":\"pack25\"} ($25 for 25,000 calls, same header pattern).",
  }, 200, { "X-Dev-Plan": PLAN });
});
