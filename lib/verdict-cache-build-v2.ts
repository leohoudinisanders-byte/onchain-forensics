// verdictCacheBuild v2 - grow the cached verdict feed as large as the RPC budget allows.
//
// v1 (Nov 6) proved the model: 24 tokens, cached, served at $0.001 with a real settlement.
// v2 removes the two ceilings v1 had:
//   1. A hardcoded 24-token universe. Discovery is now live: GeckoTerminal top-volume pools
//      per chain are walked incrementally and appended as PENDING rows, so the feed grows on
//      its own every run instead of waiting for someone to edit an array.
//   2. One shard per invocation. Work is now time-budgeted: each run spends up to ~42s
//      building, in parallel batches, then stops and lets the next run continue. The hourly
//      workflow becomes every 10 minutes, so throughput is roughly 6x higher per hour.
//
// The engine is unchanged and shared: lib/verdict-engine-v1.js = forensicsApi.ts minus the
// HTTP handler, so a cached grade can never disagree with a paid grade.
//
// Queue design: a row with grade "PENDING" is undiscovered work; a filled row is a live
// cached verdict. Freshness rotation re-reads the oldest computed rows when nothing is pending.
//
// Admin-only (called by the Verdict Cache Build workflow). Public callers get 403.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.54";
import { verdictForensics, setPreferPublic } from "https://esm.sh/gh/leohoudinisanders-byte/onchain-forensics@42f5ca7c77dc3a91151dbe802bb88364c4ee8590/lib/verdict-engine-v2.js";

const ENGINE_VERSION = "verdict-engine-v2-free";
const TIME_BUDGET_MS = 28_000;      // a batch can overrun badly, so stop well short of the ceiling
const PARALLEL = 10;                 // enough to matter, low enough to stay inside Alchemy limits
const MAX_UNIVERSE_PER_CHAIN: Record<string, number> = { base: 700, ethereum: 500 };
const PENDING_TARGET = 150;          // stop discovering once this much work is queued
const STALE_AFTER_MIN = 360;        // refresh rows older than 6 hours (RPC quota is the binding constraint)

// Curated majors: always present even if volume ranking drops them out.
const SEED: Array<{ chain: string; address: string; symbol: string; name: string }> = [
  { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", name: "USD Coin" },
  { chain: "base", address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether" },
  { chain: "base", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", symbol: "DEGEN", name: "Degen" },
  { chain: "base", address: "0x532f27101965dd16442e59d40670faf5ebb142e4", symbol: "BRETT", name: "Brett" },
  { chain: "base", address: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", symbol: "AERO", name: "Aerodrome" },
  { chain: "base", address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", symbol: "cbBTC", name: "Coinbase Wrapped BTC" },
  { chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", name: "USD Coin" },
  { chain: "ethereum", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", name: "Tether USD" },
  { chain: "ethereum", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", name: "Wrapped Ether" },
  { chain: "ethereum", address: "0x514910771af9ca656af840dff83e8264ecf986ca", symbol: "LINK", name: "Chainlink" },
];

const GT_NETWORK: Record<string, string> = { base: "base", ethereum: "eth" };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) solene-cache-builder";

type Row = { chain: string; address: string; symbol: string; name: string };

async function gt(path: string): Promise<any | null> {
  // GeckoTerminal's public API rate-limits hard, so every call backs off and returns null
  // instead of throwing: discovery is incremental and self-heals on a later run.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.geckoterminal.com/api/v2${path}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 2_500)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await new Promise((r) => setTimeout(r, 800)); }
  }
  return null;
}

async function discoverPage(chain: string, page: number): Promise<Row[]> {
  const net = GT_NETWORK[chain];
  if (!net) return [];
  const d = await gt(`/networks/${net}/pools?page=${page}&sort=h24_volume_usd_desc`);
  const pools = (d?.data ?? []) as any[];
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const p of pools) {
    for (const side of ["base_token", "quote_token"]) {
      const id = String(p?.relationships?.[side]?.data?.id ?? "");
      if (!id.startsWith(`${net}_`)) continue;
      const address = id.slice(net.length + 1).toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(address) || seen.has(address)) continue;
      seen.add(address);
      out.push({ chain, address, symbol: "", name: "" });
    }
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Alternative discovery sources. GeckoTerminal is the best data, but its edge can rate-limit
// or block datacenter egress, so the builder falls back rather than stalling.
async function discoverTokenList(chain: string): Promise<Row[]> {
  try {
    const res = await fetch("https://tokens.uniswap.org", {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    const wantId = chain === "ethereum" ? 1 : 8453;
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const t of (d?.tokens ?? [])) {
      if (t?.chainId !== wantId) continue;
      const address = String(t.address || "").toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(address) || seen.has(address)) continue;
      seen.add(address);
      out.push({ chain, address, symbol: String(t.symbol || ""), name: String(t.name || "") });
    }
    return out;
  } catch { return []; }
}

async function discoverBoosted(): Promise<Row[]> {
  try {
    const res = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const t of (Array.isArray(d) ? d : [])) {
      const chainId = String(t?.chainId || "");
      const chain = chainId === "base" ? "base" : chainId === "ethereum" ? "ethereum" : "";
      if (!chain) continue;
      const address = String(t?.tokenAddress || "").toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(address) || seen.has(`${chain}:${address}`)) continue;
      seen.add(`${chain}:${address}`);
      out.push({ chain, address, symbol: "", name: "" });
    }
    return out;
  } catch { return []; }
}

// Uniswap's default token list is the one discovery source our deployed egress can actually
// reach (GeckoTerminal 429s and DexScreener returns Cloudflare 1015 from datacenter IPs), so it
// is primary. It is fetched once per invocation and gives Base 196 + Ethereum 485 real tokens.
let UNI_CACHE: Array<{ chain: string; address: string; symbol: string; name: string }> | null = null;
async function uniswapTokens(): Promise<Array<{ chain: string; address: string; symbol: string; name: string }>> {
  if (UNI_CACHE) return UNI_CACHE;
  const out: Array<{ chain: string; address: string; symbol: string; name: string }> = [];
  try {
    const res = await fetch("https://tokens.uniswap.org", {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const d = await res.json();
      const seen = new Set<string>();
      for (const t of (d?.tokens ?? [])) {
        const chain = t?.chainId === 8453 ? "base" : t?.chainId === 1 ? "ethereum" : "";
        if (!chain) continue;
        const address = String(t.address || "").toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(address)) continue;
        const key = `${chain}:${address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ chain, address, symbol: String(t.symbol || ""), name: String(t.name || "") });
      }
    }
  } catch { /* fall through to an empty list */ }
  UNI_CACHE = out;
  return out;
}

// Which hosts can actually carry a log read from this egress? Free nodes vary wildly: some serve
// eth_getLogs, some cap the range, some Cloudflare-block us. Measured, never assumed.
const RPC_CANDIDATES: Record<string, string[]> = {
  base: [
    "https://base.gateway.tenderly.co",
    "https://base-rpc.publicnode.com",
    "https://base.blockpi.network/v1/rpc/public",
    "https://base.meowrpc.com",
    "https://base-mainnet.public.blastapi.io",
    "https://developer-access-mainnet.base.org",
    "https://base.drpc.org",
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
    "https://mainnet.base.org",
    "https://gateway.tenderly.co/public/base",
  ],
  ethereum: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://eth.blockpi.network/v1/rpc/public",
    "https://eth.drpc.org",
    "https://1rpc.io/eth",
    "https://eth-mainnet.public.blastapi.io",
    "https://gateway.tenderly.co/public/mainnet",
  ],
};
const USDC_LOGS: Record<string, string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
};

async function probeRpc(url: string, chain: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  try {
    const head = await call("eth_blockNumber", []);
    const latest = parseInt(String(head.body?.result || "0x0"), 16);
    if (!latest) return { url, chain, head_status: head.status, error: String(head.body?.error?.message || "no_block").slice(0, 90), ms: Date.now() - t0 };
    // 100-block USDC window: the smallest read the engine actually issues.
    const from = "0x" + Math.max(0, latest - 100).toString(16);
    const logs = await call("eth_getLogs", [{ address: USDC_LOGS[chain], fromBlock: from, toBlock: "latest" }]);
    const ok = Array.isArray(logs.body?.result);
    return {
      url, chain,
      block: latest,
      logs_status: logs.status,
      logs_ok: ok,
      logs: ok ? logs.body.result.length : 0,
      range_error: ok ? "" : String(logs.body?.error?.message || "unknown").slice(0, 70),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { url, chain, error: String(e).slice(0, 90), ms: Date.now() - t0 };
  }
}

async function probe(url: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    const text = await res.text();
    let n = 0;
    try { const j = JSON.parse(text); n = Array.isArray(j?.data) ? j.data.length : Array.isArray(j?.tokens) ? j.tokens.length : Array.isArray(j) ? j.length : 0; } catch { /* non-json */ }
    return { url, status: res.status, items: n, ms: Date.now() - t0, head: text.slice(0, 80) };
  } catch (e) {
    return { url, status: 0, error: String(e).slice(0, 120), ms: Date.now() - t0 };
  }
}

Deno.serve(async (req) => {
  const started = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "forbidden" }, { status: 403 });

    const url = new URL(req.url);
    const body = await req.clone().json().catch(() => ({} as any));
    if (body?.rpc_diag) {
      const out: unknown[] = [];
      for (const chain of ["base", "ethereum"]) {
        for (const u of RPC_CANDIDATES[chain]) out.push(await probeRpc(u, chain));
      }
      return Response.json({ ok: true, rpc_diag: true, hosts: out });
    }

    if (body?.diag) {
      const urls = [
        "https://api.geckoterminal.com/api/v2/networks/base/pools?page=1&sort=h24_volume_usd_desc",
        "https://tokens.uniswap.org",
        "https://api.dexscreener.com/token-boosts/top/v1",
      ];
      const results = [];
      for (const u of urls) results.push(await probe(u));
      return Response.json({ ok: true, diag: true, results });
    }

    // Free way: public hosts carry the load, Alchemy only pays out if every free node fails.
    setPreferPublic(body?.paid === true ? false : true);

    const ent = base44.asServiceRole.entities.TokenVerdictCache;
    const report: Record<string, unknown> = { engine: ENGINE_VERSION };

    // ---- 1) Seed curated majors on first ever run -------------------------------------
    const all = await ent.list("-computed_at", 2000);
    const known = new Set((all ?? []).map((r: any) => r.cache_key));
    if ((all ?? []).length === 0) {
      for (const s of SEED) {
        const key = `${s.chain}:${s.address}`;
        await ent.create({ chain: s.chain, address: s.address, cache_key: key, symbol: s.symbol, name: s.name, grade: "PENDING", engine_version: ENGINE_VERSION });
        known.add(key);
      }
      report.seeded = SEED.length;
    }

    // ---- 2) Discovery: grow the universe while the queue is thin -----------------------
    // Primary source: Uniswap token list (reachable from our egress, 681 EVM tokens across the
    // two chains we serve). Bytes are inserted as PENDING rows in bounded batches so one run
    // never spends its whole budget writing queue entries.
    const pendingNow = (all ?? []).filter((r: any) => r.grade === "PENDING").length;
    let discovered = 0;
    let sourceUsed = "none";
    if (pendingNow < PENDING_TARGET) {
      const counts: Record<string, number> = { base: 0, ethereum: 0 };
      for (const r of all ?? []) if (counts[r.chain] !== undefined) counts[r.chain]++;
      const budgetLeft = PENDING_TARGET - pendingNow;

      let candidates: Row[] = (await uniswapTokens()).filter((t) => counts[t.chain] < MAX_UNIVERSE_PER_CHAIN[t.chain]);
      if (candidates.length) sourceUsed = "uniswap-list";

      if (!candidates.length) {
        // Fallbacks: GeckoTerminal top pools, then DexScreener boosts. Both may be rate-limited
        // from this egress; a single attempt each keeps a failed source cheap.
        for (const chain of ["base", "ethereum"]) {
          if (counts[chain] >= MAX_UNIVERSE_PER_CHAIN[chain]) continue;
          candidates = candidates.concat(await discoverPage(chain, 1));
        }
        if (candidates.length) sourceUsed = "geckoterminal";
      }
      if (!candidates.length) {
        candidates = await discoverBoosted();
        if (candidates.length) sourceUsed = "dexscreener-boosts";
      }

      // Base tokens lead the queue: faster reads, and they are what x402 callers ask about.
      candidates.sort((a, b) => (a.chain === b.chain ? 0 : a.chain === "base" ? -1 : 1));
      const fresh = candidates.filter((r) => !known.has(`${r.chain}:${r.address}`)).slice(0, budgetLeft);
      for (const batch of chunk(fresh, 20)) {
        if (Date.now() - started > TIME_BUDGET_MS * 0.35) break;
        await Promise.all(batch.map((r) =>
          ent.create({
            chain: r.chain, address: r.address, cache_key: `${r.chain}:${r.address}`,
            symbol: r.symbol || "", name: r.name || "",
            grade: "PENDING", engine_version: ENGINE_VERSION,
          }).catch(() => null)
        ));
        for (const r of batch) known.add(`${r.chain}:${r.address}`);
        discovered += batch.length;
      }
    }
    report.source = sourceUsed;
    report.discovered = discovered;

    // ---- 3) Build: work the queue in parallel batches inside the time budget ----------
    const pending = (await ent.filter({ grade: "PENDING" }, "-created_date", 200)) ?? [];
    const stale = (await ent.list("computed_at", 200)) ?? [];
    const staleRows = (stale ?? []).filter((r: any) => {
      if (!r.computed_at || r.grade === "PENDING") return false;
      return (Date.now() - new Date(r.computed_at).getTime()) / 60000 > STALE_AFTER_MIN;
    });

    // Base first: those reads are faster and they are the tokens x402 callers ask about most.
    const chainRank = (c: string) => (c === "base" ? 0 : 1);
    const isRetry = (r: any) => String(r.data_quality || "").startsWith("UNGRADEABLE");
    const ordered = [...pending].sort((a: any, b: any) => {
      const ra = isRetry(a) ? 1 : 0, rb = isRetry(b) ? 1 : 0;
      if (ra !== rb) return ra - rb;        // fresh tokens first, retries only if time remains
      return chainRank(a.chain) - chainRank(b.chain);
    });
    const work: any[] = ordered.length ? ordered : staleRows;
    const mode = pending.length ? "pending" : "refresh";
    report.mode = mode;
    report.queue = work.length;

    let built = 0, failed = 0, skipped = 0, retried = 0;
    let quotaHit = false;
    const grades: string[] = [];
    const failures: string[] = [];

    const isQuota = (msg: string) =>
      /usage limit|rate limit|429|compute units|exceeded/i.test(msg);

    for (const batch of chunk(work, PARALLEL)) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      if (quotaHit) break;   // the RPC plan is exhausted: stop burning time, resume next run
      await Promise.all(batch.map(async (row: any) => {
        const t0 = Date.now();
        try {
          const verdict = (await verdictForensics(row.address, row.chain)) as any;
          const ms = Date.now() - t0;
          const got = String(verdict?.token_symbol ?? "").trim();
          if (!verdict || !verdict.grade) { failed++; failures.push(`${row.chain}:${row.address.slice(0, 10)} no_grade`); return; }
          if (String(verdict.grade) === "?" || verdict.activity_status === "UNAVAILABLE") {
            // An unreadable chain is not a verdict. Retry a couple of times in case the window was
            // genuinely quiet, then retire the row: a token with no readable activity will never
            // produce a verdict and must stop consuming RPC quota every run.
            const attempts = Number((String(row.data_quality || "").match(/^UNGRADEABLE_(\d+)$/) || [])[1] || 0) + 1;
            retried++;
            if (attempts >= 3) {
              await ent.update(row.id, {
                grade: "STALE",
                data_quality: `UNGRADEABLE_${attempts}`,
                roast: "no readable activity window after 3 attempts; retired from the feed",
              }).catch(() => null);
              if (failures.length < 15) failures.push(`${row.chain}:${row.address.slice(0, 10)} retired_unreadable`);
            } else {
              await ent.update(row.id, { data_quality: `UNGRADEABLE_${attempts}` }).catch(() => null);
              if (failures.length < 15) failures.push(`${row.chain}:${row.address.slice(0, 10)} ungradeable_retry_${attempts}`);
            }
            return;
          }
          if (row.symbol && got && got.toUpperCase() !== row.symbol.toUpperCase()) {
            // A curated row whose symbol moved means my address is stale: retire it rather
            // than overwrite the name with whatever lives there now.
            if (SEED.some((s) => s.address === row.address)) {
              skipped++; failures.push(`${row.symbol} symbol_mismatch:${got}`);
              await ent.update(row.id, { grade: "STALE", roast: `address now holds ${got}, not ${row.symbol}` }).catch(() => null);
              return;
            }
          }
          await ent.update(row.id, {
            symbol: got || row.symbol || "",
            name: String(verdict?.token_name ?? row.name ?? ""),
            grade: String(verdict.grade),
            tier: String(verdict?.verdict_tier ?? "UNKNOWN"),
            score: Number(verdict?.activity_score_0_100 ?? 0),
            roast: String(verdict?.roast ?? ""),
            window_min: Number(verdict?.window_min ?? 0),
            data_quality: String(verdict?.activity_status ?? "OK"),
            payload_json: JSON.stringify(verdict),
            computed_at: new Date().toISOString(),
            build_ms: ms,
            engine_version: ENGINE_VERSION,
          });
          built++;
          if (grades.length < 40) grades.push(`${got || row.address.slice(0, 8)}=${verdict.grade}`);
        } catch (e) {
          const msg = String(e);
          if (isQuota(msg)) {
            quotaHit = true;
            retried++;
            if (failures.length < 15) failures.push(`quota: ${msg.slice(0, 90)}`);
            return;
          }
          failed++;
          if (failures.length < 15) failures.push(`${row.chain}:${row.address.slice(0, 10)} ${msg.slice(0, 80)}`);
        }
      }));
      await new Promise((r) => setTimeout(r, 150));
    }

    // ---- 4) Coverage snapshot --------------------------------------------------------
    const after = await ent.list("-computed_at", 2000);
    const rows: any[] = after ?? [];
    const live = rows.filter((r) => r.grade && r.grade !== "PENDING" && r.grade !== "STALE");
    const byChain: Record<string, number> = {};
    const byGrade: Record<string, number> = {};
    for (const r of live) {
      byChain[r.chain] = (byChain[r.chain] ?? 0) + 1;
      byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1;
    }

    return Response.json({
      ok: true,
      engine: ENGINE_VERSION,
      elapsed_ms: Date.now() - started,
      discovered,
      mode,
      built,
      failed,
      skipped,
      retried,
      rpc_quota_hit: quotaHit,
      grades,
      failures,
      coverage: { cached: live.length, pending: rows.filter((r) => r.grade === "PENDING").length, by_chain: byChain, by_grade: byGrade },
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
});
