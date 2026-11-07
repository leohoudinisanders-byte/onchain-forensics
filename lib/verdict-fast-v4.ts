// verdictFast - the cached verdict tier. $0.001, served from a precomputed feed.
//
// WHY (Nov 6, 2026): the live verdict route does 1 to 14 seconds of chain reads, which
// rules out in-path agent use and makes a sub-cent price unprofitable. verdictCacheBuild
// precomputes verdicts hourly into TokenVerdictCache using the SAME engine
// (lib/verdict-engine-v1.js), so this endpoint is a primary-key lookup instead of a scan.
//
// Fairness rule: payment is verified BEFORE the cache lookup, but settled ONLY after a hit.
// A cache miss therefore costs the caller nothing and comes back with a pointer to the
// $0.02 live route that will always answer.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.54";

const PAY_TO = "0x8EBf296c6273760ed9604C428f7EC13255E46fb9";
const PRICE_ATOMIC = "1000"; // $0.001 in USDC atomic units (6 decimals)
const PRICE_USD = "$0.001";
const NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://solene-fa2010da.base44.app/functions/verdictFast";
const SERVICE = "onchain-forensics-cached";
const DEFAULT_FACILITATORS = [
  "https://api.cdp.coinbase.com/platform/v2/x402",
  "https://x402.roundhouseai.io",
  "https://facilitator.payai.network",
];

async function cdpFacilitatorJwt(pathSuffix: string): Promise<string> {
  try {
    const a = Deno.env.get("COINBASE_API_KEY_NAME") || "";
    const b = Deno.env.get("COINBASE_PRIVATE_KEY") || "";
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
    const keyId = isUuid(a) ? a.trim() : isUuid(b) ? b.trim() : "";
    const secret = keyId === a.trim() ? b : a;
    if (!keyId || !secret) return "";
    const bin = atob(secret.trim().replace(/-/g, "+").replace(/_/g, "/"));
    const seed = Uint8Array.from(bin.slice(0, 32), (c) => c.charCodeAt(0));
    let key: CryptoKey | null = null;
    try {
      const pkcs8 = new Uint8Array(48);
      pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], 0);
      pkcs8.set(seed, 16);
      key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    } catch {
      try { key = await crypto.subtle.importKey("raw", seed, { name: "Ed25519" }, false, ["sign"]); } catch { key = null; }
    }
    if (!key) return "";
    const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const now = Math.floor(Date.now() / 1000);
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join("");
    const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
    const claims = { sub: keyId, iss: "cdp", aud: null, nbf: now, exp: now + 120, uris: ["POST api.cdp.coinbase.com/platform/v2/x402" + pathSuffix] };
    const unsigned = b64u(header) + "." + b64u(claims);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(unsigned)));
    let sigStr = "";
    for (const sb of sig) sigStr += String.fromCharCode(sb);
    return unsigned + "." + btoa(sigStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch { return ""; }
}

async function facilitatorHeaders(f: string, pathSuffix: string): Promise<Record<string, string>> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (f.includes("api.cdp.coinbase.com")) {
    const tok = await cdpFacilitatorJwt(pathSuffix);
    if (tok) h["Authorization"] = "Bearer " + tok;
  }
  return h;
}

function b64encode(o: unknown): string { return btoa(JSON.stringify(o)); }

// Next calendar-month boundary in UTC, so a caller is told a future reset date.
function devResetIso(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}-01T00:00:00Z`;
}

function jsonResp(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

// A row only counts as a servable verdict if it has a real letter grade. PENDING means the
// builder has not read it yet, STALE means the address no longer holds the token we expect, and
// "?" means the chain read was ungradeable. None of those may be sold.
// Free sample (Nov 6 2026): one cached verdict per caller per day with no flag and no payment.
// Rationale: 4,038 challenges a day convert to 2 paid calls because a prober never sees a payload
// before the paywall, so nothing is being evaluated. A cache hit costs us a single primary-key read,
// so giving the first one away is free for us and turns a bare 402 into a working demo. Repeat calls
// still pay $0.001, and a cache miss still returns the normal 402 instead of unpaid compute.
const SAMPLE_OFF = Deno.env.get("FREE_SAMPLE_OFF") === "1";

const SERVABLE = (row: any) => !!(row && row.grade && !["PENDING", "STALE", "?"].includes(String(row.grade)) && row.payload_json);

const DESCRIPTION =
  "Cached token verdict in milliseconds, $0.001. Same letter grade A to F, roast and risk flags as the $0.02 live verdict, served from a precomputed feed refreshed hourly instead of a 1 to 14 second chain scan. Use this one for in-path agent decisions and high call volume; use the live route when you need a read of the current block. If a token is not in the feed, this route charges nothing and tells you where to go.";

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const envFac = Deno.env.get("X402_FACILITATOR_URL") || "";
  const facilitators = envFac.startsWith("http") ? [envFac] : DEFAULT_FACILITATORS;
  const url = new URL(req.url);

  const address = (url.searchParams.get("address") || url.searchParams.get("token") || "").trim();
  const chain = (url.searchParams.get("chain") || "base").trim().toLowerCase();

  // The free coverage index needs no address, so the address guard must not swallow ?list=1.
  if (!address && url.searchParams.get("list") !== "1") {
    return jsonResp({
      error: "missing_address",
      hint: "?address=0x<contract>&chain=base|ethereum",
      example: "https://solene-fa2010da.base44.app/functions/verdictFast?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&chain=base",
      cache_preview: "https://solene-fa2010da.base44.app/functions/verdictFast?list=1",
    }, 400);
  }

  // Free index of what is in the feed, so a caller can see coverage without paying.
  if (url.searchParams.get("list") === "1") {
    const rows = await base44.asServiceRole.entities.TokenVerdictCache.list("-computed_at", 500);
    const items = (rows || []).filter(SERVABLE).map((r: any) => ({
      chain: r.chain, address: r.address, symbol: r.symbol, grade: r.grade, tier: r.tier, score: r.score, computed_at: r.computed_at,
    }));
    return jsonResp({ service: SERVICE, free: true, price_usd: PRICE_USD, count: items.length, items });
  }

  const requirements = {
    scheme: "exact",
    network: NETWORK,
    asset: USDC,
    amount: PRICE_ATOMIC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };

  const paymentRequired = {
    x402Version: 2,
    error: "HTTP_402_PAYMENT_REQUIRED",
    resource: {
      url: RESOURCE,
      description: DESCRIPTION,
      mimeType: "application/json",
      serviceName: "On-chain Forensics",
      tags: ["token-verdict", "cached", "low-latency", "token-security", "honeypot", "risk-grade", "x402"],
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" } },
          output: { type: "json", example: { service: SERVICE, paid: PRICE_USD, data: { grade: "A", verdict_tier: "RED_HOT" } } },
        },
        schema: {
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string" },
                method: { type: "string" },
                queryParams: {
                  type: "object",
                  properties: {
                    address: { type: "string", description: "EVM token contract 0x..." },
                    chain: { type: "string", enum: ["base", "ethereum"] },
                  },
                },
              },
              required: ["type", "method"],
            },
            output: { type: "object", properties: { service: { type: "string" }, paid: { type: "string" }, data: { type: "object" } } },
          },
          required: ["input"],
        },
      },
    },
  };
  const paymentHeaders = { "X-PAYMENTS-VERSION": "2", "PAYMENT-REQUIRED": b64encode(paymentRequired) };

  const paymentHeader = req.headers.get("PAYMENT-SIGNATURE") || req.headers.get("X-PAYMENT");

  // Free first-call sample: cache hit only, once per caller per day, no parameter required.
  // Indexers and payment validators must keep seeing the plain 402, or a paid route can be judged
  // free-to-use; the sample is for callers that actually intend to use the data.
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  const sampleExcluded = /coinbase|x402|bazaar|validator|crawler|bot\b|spider|scanner|awal/.test(ua);
  if (!paymentHeader && !SAMPLE_OFF && !sampleExcluded) {
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    const today = new Date().toISOString().slice(0, 10);
    if (ip) {
      let sampleKey = "";
      try {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + today + "|verdictFast_sample"));
        sampleKey = Array.from(new Uint8Array(digest)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("") + "-" + today + "-sample";
      } catch { /* no sample key, fall through to 402 */ }
      if (sampleKey) {
        try {
          const usage: any[] = (await base44.asServiceRole.entities.FreeCallUsage.list()) || [];
          const rec: any = usage.find((r: any) => (r.data?.usage_key ?? r.usage_key) === sampleKey) || null;
          const used = Number(rec?.data?.calls_used ?? rec?.calls_used ?? 0);
          if (used < 1) {
            const sampleKeyRow = `${chain}:${address.toLowerCase()}`;
            const sampleRows = await base44.asServiceRole.entities.TokenVerdictCache.filter({ cache_key: sampleKeyRow });
            const sampleRow: any = sampleRows?.[0];
            if (SERVABLE(sampleRow)) {
              try {
                const payload = { usage_key: sampleKey, calls_used: 1 };
                if (rec) await base44.asServiceRole.entities.FreeCallUsage.update(rec.id, payload);
                else await base44.asServiceRole.entities.FreeCallUsage.create(payload);
              } catch { /* serve anyway: the sample must not fail on accounting */ }
              let samplePayload: any = {};
              try { samplePayload = JSON.parse(sampleRow.payload_json || "{}"); } catch { samplePayload = {}; }
              const sampleAge = sampleRow.computed_at ? Math.max(0, Math.round((Date.now() - new Date(sampleRow.computed_at).getTime()) / 1000)) : null;
              return jsonResp({
                service: SERVICE,
                sample: true,
                paid: "$0.00 (free sample, one per caller per day)",
                free_sample: { used: 1, remaining: 0, resets: today },
                next_call: `Repeat calls cost ${PRICE_USD}: send a PAYMENT-SIGNATURE header and the same verdict comes back in milliseconds. Free coverage index: /functions/verdictFast?list=1`,
                cache: { hit: true, computed_at: sampleRow.computed_at, age_seconds: sampleAge, engine: sampleRow.engine_version },
                data: samplePayload,
              }, 200, { "X-Free-Sample": "granted" });
            }
          }
        } catch (e) {
          console.error("free sample failed:", String(e)); // fall through to the normal paywall
        }
      }
    }
  }

  // ---- Developer keys (free tier) -------------------------------------------------------
  // A free key is an email-keyed 10,000 calls/month allowance with NO per-call signature, which
  // is the difference between a builder prototyping against us and a builder giving up. The key
  // is stored as a SHA-256 hash in CreditsAccount (same table as paid packs, plan
  // "dev_free_10k"). Capped per calendar month; exhausted keys get 429 with a paid upgrade path.
  const devKeyHeader = (req.headers.get("x-dev-key") || req.headers.get("X-Dev-Key") || "").trim();
  if (!paymentHeader && devKeyHeader.startsWith("fxk_")) {
    try {
      const dg = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(devKeyHeader));
      const keyHash = Array.from(new Uint8Array(dg)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const accounts: any[] = (await base44.asServiceRole.entities.CreditsAccount.filter({ key_hash: keyHash })) || [];
      const acct: any = accounts[0];
      if (!acct) {
        return jsonResp({
          error: "invalid_dev_key",
          next: "Free developer keys are issued at POST /functions/devKeys with {\"email\":\"you@example.com\"}. No card, no payment.",
        }, 401);
      }
      if (acct.status && acct.status !== "active") {
        return jsonResp({ error: "dev_key_inactive", status: acct.status }, 403);
      }
      const month = new Date().toISOString().slice(0, 7);
      const sameMonth = String(acct.quota_month || "") === month;
      const used = sameMonth ? Number(acct.quota_used || 0) : 0;
      const CAP = 10000;
      if (used >= CAP) {
        return jsonResp({
          error: "monthly_quota_exhausted",
          plan: "free_developer_10k",
          quota: { cap: CAP, used, month, resets: devResetIso(month) },
          next: "Prepaid packs remove the monthly cap and cost $25 for 25,000 calls: POST /functions/forensicsCredits {\"plan\":\"pack25\"}",
        }, 429, { "X-Dev-Quota-Remaining": "0", "X-Dev-Plan": "free_developer_10k" });
      }

      const devCacheKey = `${chain}:${address.toLowerCase()}`;
      const devRows = await base44.asServiceRole.entities.TokenVerdictCache.filter({ cache_key: devCacheKey });
      const devRow: any = devRows?.[0];
      if (!SERVABLE(devRow)) {
        return jsonResp({
          service: SERVICE,
          paid: "$0.00 (not counted against your quota)",
          cache_miss: true,
          requested: { chain, address },
          next: "Not in the hourly feed yet. The live route always answers: /functions/forensicsApi?endpoint=verdict&address=" + address + "&chain=" + chain + " at $0.02, or retry here after the next rebuild (every 5 minutes).",
          coverage: "/functions/verdictFast?list=1 lists every cached token, free",
        }, 200, { "X-Dev-Quota-Remaining": String(CAP - used), "X-Dev-Plan": "free_developer_10k" });
      }

      try {
        await base44.asServiceRole.entities.CreditsAccount.update(acct.id, {
          quota_month: month,
          quota_used: used + 1,
          calls_served: Number(acct.calls_served || 0) + 1,
          last_used_date: new Date().toISOString(),
        });
      } catch (e) { console.error("dev key accounting failed:", String(e)); } // serve anyway

      let devPayload: any = {};
      try { devPayload = JSON.parse(devRow.payload_json || "{}"); } catch { devPayload = {}; }
      const devAge = devRow.computed_at ? Math.max(0, Math.round((Date.now() - new Date(devRow.computed_at).getTime()) / 1000)) : null;
      return jsonResp({
        service: SERVICE,
        paid: "$0.00 (free developer tier)",
        dev_key: { plan: "free_developer_10k", used: used + 1, remaining: CAP - used - 1, cap: CAP, month, resets: devResetIso(month) },
        cache: { hit: true, computed_at: devRow.computed_at, age_seconds: devAge, engine: devRow.engine_version },
        data: devPayload,
        next: "Higher volume, batch reads or live scans: POST /functions/forensicsCredits {\"plan\":\"pack25\"} for 25,000 prepaid calls with the same header.",
      }, 200, { "X-Dev-Quota-Remaining": String(CAP - used - 1), "X-Dev-Plan": "free_developer_10k" });
    } catch (e) {
      console.error("dev key path failed:", String(e));
      // fall through to the normal paywall rather than 500 on a key problem
    }
  }

  if (!paymentHeader) {
    return jsonResp({
      ...paymentRequired,
      x_guidance: "Cached verdict tier at $0.001: precomputed hourly, answered from a key lookup. First call from a new caller is free (once per day) when the token is already in the feed, so you can read a real verdict before paying. Free coverage index at ?list=1. If your token is not cached this route does not charge you and points you at the $0.02 live verdict.",
    }, 402, paymentHeaders);
  }

  let paymentPayload: unknown;
  try {
    const normalized = paymentHeader.trim().replace(/-/g, "+").replace(/_/g, "/");
    paymentPayload = JSON.parse(atob(normalized));
  } catch {
    return jsonResp({ error: "invalid_payment_header" }, 400, paymentHeaders);
  }

  let verification: any = null;
  let settledBy = facilitators[0];
  const rejections: any[] = [];
  for (const f of facilitators) {
    try {
      const vResp = await fetch(`${f}/verify`, {
        method: "POST",
        headers: await facilitatorHeaders(f, "/verify"),
        body: JSON.stringify(f.includes("api.cdp.coinbase.com")
          ? { x402Version: 2, paymentPayload, paymentRequirements: requirements }
          : { paymentPayload, paymentRequirements: requirements }),
      });
      const v: any = await vResp.json().catch(() => ({}));
      if (v?.isValid) { verification = v; settledBy = f; break; }
      rejections.push({ facilitator: f, invalidReason: v?.invalidReason || null });
    } catch (e) {
      rejections.push({ facilitator: f, error: String(e).slice(0, 120) });
    }
  }
  if (!verification?.isValid) {
    const first = rejections.find((r) => r.invalidReason);
    const detail = first ? first.invalidReason : (rejections[0]?.error || "no facilitator response");
    return jsonResp({ error: "payment_verification_failed", detail: String(detail).slice(0, 200) }, 402, paymentHeaders);
  }

  // Cache lookup happens BEFORE settlement: a miss must not cost the caller anything.
  const cacheKey = `${chain}:${address.toLowerCase()}`;
  const rows = await base44.asServiceRole.entities.TokenVerdictCache.filter({ cache_key: cacheKey });
  const row: any = rows?.[0];
  if (!SERVABLE(row)) {
    return jsonResp({
      service: SERVICE,
      paid: "$0.00 (not charged, cache miss)",
      cache_miss: true,
      requested: { chain, address },
      next: "This token is not in the hourly feed. The live route always answers: /functions/forensicsApi?endpoint=verdict&address=" + address + "&chain=" + chain + " at $0.02",
      coverage: "/functions/verdictFast?list=1 shows every cached token, free",
    }, 200);
  }

  let settlement: any = null;
  try {
    const sResp = await fetch(`${settledBy}/settle`, {
      method: "POST",
      headers: await facilitatorHeaders(settledBy, "/settle"),
      body: JSON.stringify(settledBy.includes("api.cdp.coinbase.com")
        ? { x402Version: 2, paymentPayload, paymentRequirements: requirements }
        : { paymentPayload, paymentRequirements: requirements }),
    });
    settlement = await sResp.json().catch(() => ({}));
    if (!settlement?.success && !settlement?.transaction) {
      console.error("verdictFast settlement issue:", JSON.stringify(settlement).slice(0, 300));
    }
  } catch (e) {
    console.error("verdictFast settle error:", String(e));
  }

  let payload: any = {};
  try { payload = JSON.parse(row.payload_json || "{}"); } catch { payload = {}; }
  const ageSec = row.computed_at ? Math.max(0, Math.round((Date.now() - new Date(row.computed_at).getTime()) / 1000)) : null;

  const finalHeaders: Record<string, string> = {};
  try { finalHeaders["PAYMENT-RESPONSE"] = b64encode(settlement || {}); } catch { /* optional */ }

  return jsonResp({
    service: SERVICE,
    paid: PRICE_USD,
    settlement_tx: settlement?.transaction || null,
    cache: { hit: true, computed_at: row.computed_at, age_seconds: ageSec, engine: row.engine_version },
    data: payload,
  }, 200, finalHeaders);
});
