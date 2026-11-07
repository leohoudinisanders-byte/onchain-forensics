// verdictBatch - the screen-the-whole-list tier. $1.00 for up to 25 cached verdicts in one call.
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
const PRICE_ATOMIC = "1000000"; // $1.00 in USDC atomic units (6 decimals)
const PRICE_USD = "$1.00";
const NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://solene-fa2010da.base44.app/functions/verdictBatch";
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

function jsonResp(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}


// A row only counts as a servable verdict if it has a real letter grade.
const SERVABLE = (row: any) => !!(row && row.grade && !["PENDING", "STALE", "?"].includes(String(row.grade)) && row.payload_json);

const MAX_TOKENS = 25;

const DESCRIPTION =
  "Batch token screen: up to 25 cached verdicts in one paid call for $1.00. Same letter grades, roasts and risk flags as the single $0.02 verdict, answered from the precomputed feed in one round trip, so an agent can screen a whole candidate list before it commits capital. Tokens missing from the feed come back as explicit misses with a pointer to the live route, and if nothing in the batch is cached the call is not charged.";

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const envFac = Deno.env.get("X402_FACILITATOR_URL") || "";
  const facilitators = envFac.startsWith("http") ? [envFac] : DEFAULT_FACILITATORS;
  const url = new URL(req.url);

  // Input: POST {"addresses":["0x..","0x.."], "chain":"base"} or GET ?addresses=0x..,0x..&chain=base
  let body: any = {};
  if (req.method === "POST") { try { body = await req.clone().json(); } catch { body = {}; } }
  const rawList = body?.addresses ?? url.searchParams.get("addresses") ?? "";
  const list: string[] = (Array.isArray(rawList) ? rawList : String(rawList).split(/[,\s]+/))
    .map((a: unknown) => String(a).trim())
    .filter((a: string) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const chain = String(body?.chain ?? url.searchParams.get("chain") ?? "base").trim().toLowerCase();

  if (!list.length) {
    return jsonResp({
      error: "missing_addresses",
      hint: `Send 1 to ${MAX_TOKENS} EVM contract addresses as {"addresses":["0x..."]} or ?addresses=0x...,0x...&chain=base|ethereum`,
      example: { addresses: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0x4200000000000000000000000000000000000006"], chain: "base" },
      single_token_alternative: "/functions/verdictFast?address=0x<token>&chain=base at $0.001",
    }, 400);
  }
  if (list.length > MAX_TOKENS) {
    return jsonResp({ error: "too_many_addresses", limit: MAX_TOKENS, got: list.length, hint: `Send at most ${MAX_TOKENS} addresses per call; split larger screens into batches.` }, 400);
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
      tags: ["token-verdict", "batch", "screening", "cached", "low-latency", "token-security", "risk-grade", "x402"],
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", body: { addresses: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], chain: "base" } },
          output: { type: "json", example: { service: SERVICE, paid: PRICE_USD, hits: 25, misses: 0, results: [{ address: "0x8335...", grade: "A", verdict_tier: "RED_HOT" }] } },
        },
        schema: {
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string" },
                method: { type: "string" },
                body: {
                  type: "object",
                  properties: {
                    addresses: { type: "array", items: { type: "string" }, maxItems: MAX_TOKENS, description: "EVM token contracts, up to 25" },
                    chain: { type: "string", enum: ["base", "ethereum"] },
                  },
                  required: ["addresses"],
                },
              },
              required: ["type", "method"],
            },
            output: { type: "object", properties: { service: { type: "string" }, paid: { type: "string" }, results: { type: "array" } } },
          },
          required: ["input"],
        },
      },
    },
  };
  const paymentHeaders = { "X-PAYMENTS-VERSION": "2", "PAYMENT-REQUIRED": b64encode(paymentRequired) };

  const paymentHeader = req.headers.get("PAYMENT-SIGNATURE") || req.headers.get("X-PAYMENT");
  if (!paymentHeader) {
    return jsonResp({
      ...paymentRequired,
      x_guidance: `Batch screen at ${PRICE_USD} for up to ${MAX_TOKENS} cached verdicts in one round trip. Free coverage index at /functions/verdictFast?list=1 shows what is already computed, so you can aim a batch at cached tokens. Nothing cached in your batch means the call is not charged.`,
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
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
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

  // Resolve every cache key BEFORE settlement: an empty batch must not cost the caller anything.
  const unique = Array.from(new Set(list.map((a) => a.toLowerCase())));
  const rows: any[] = [];
  for (const addr of unique) {
    try {
      const found = await base44.asServiceRole.entities.TokenVerdictCache.filter({ cache_key: `${chain}:${addr}` });
      const row: any = found?.[0];
      if (SERVABLE(row)) rows.push(row);
    } catch { /* a failed lookup is a miss, not a charge */ }
  }

  if (!rows.length) {
    return jsonResp({
      service: SERVICE,
      paid: "$0.00 (not charged, nothing in the batch is cached)",
      batch: { requested: unique.length, hits: 0, chain },
      next: "None of these tokens are in the hourly feed yet. The live route always answers at $0.02 per token: /functions/forensicsApi?endpoint=verdict&address=<address>&chain=" + chain,
      coverage: "/functions/verdictFast?list=1 shows every cached token, free",
    }, 200);
  }

  let settlement: any = null;
  try {
    const sResp = await fetch(`${settledBy}/settle`, {
      method: "POST",
      headers: await facilitatorHeaders(settledBy, "/settle"),
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
    });
    settlement = await sResp.json().catch(() => ({}));
    if (!settlement?.success && !settlement?.transaction) {
      console.error("verdictBatch settlement issue:", JSON.stringify(settlement).slice(0, 300));
    }
  } catch (e) {
    console.error("verdictBatch settle error:", String(e));
  }

  const misses = unique.filter((a) => !rows.some((r) => String(r.address).toLowerCase() === a));
  const results = rows.map((r) => {
    let payload: any = {};
    try { payload = JSON.parse(r.payload_json || "{}"); } catch { payload = {}; }
    const ageSec = r.computed_at ? Math.max(0, Math.round((Date.now() - new Date(r.computed_at).getTime()) / 1000)) : null;
    return {
      address: r.address,
      chain: r.chain,
      symbol: r.symbol,
      grade: r.grade,
      tier: r.tier,
      score: r.score,
      computed_at: r.computed_at,
      age_seconds: ageSec,
      engine: r.engine_version,
      verdict: payload,
    };
  });

  const finalHeaders: Record<string, string> = {};
  try { finalHeaders["PAYMENT-RESPONSE"] = b64encode(settlement || {}); } catch { /* optional */ }
  finalHeaders["X-Batch-Hits"] = String(rows.length);
  finalHeaders["X-Batch-Misses"] = String(misses.length);

  return jsonResp({
    service: SERVICE,
    paid: PRICE_USD,
    settlement_tx: settlement?.transaction || null,
    batch: { requested: unique.length, hits: rows.length, misses: misses.length, chain, price_per_token: "$0.04" },
    results,
    missed: misses.map((a) => ({ address: a, reason: "not_in_cache", live_route: "/functions/forensicsApi?endpoint=verdict&address=" + a + "&chain=" + chain + " ($0.02)" })),
    note: misses.length ? "Missed tokens were not charged individually; the batch price is flat. The live route grades any token in 1 to 14 seconds." : "Full hit: every requested token was served from the precomputed feed.",
  }, 200, finalHeaders);
});
