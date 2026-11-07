// On-chain Forensics A2A server - Cloud Run edition.
//
// Same protocol surface as the Base44 function (A2A v0.3 methods plus v1.0 aliases),
// packaged to run as a container on Google Cloud Run so the agent is hosted on Google
// Cloud for marketplace hosting-pattern compliance.
//
// Data path, deliberately two-layered:
//   1. Cached verdicts come from GRADE_SOURCE (default: the public grade cache API), so the
//      answer is the same one the paid product returns.
//   2. Live chain facts are read HERE, in the container, over RPC (eth_call/eth_getCode), so
//      the compute plane genuinely runs on Google Cloud. See /healthz for a live probe.
//
// Env:
//   PORT                 (Cloud Run injects it) default 8080
//   PUBLIC_BASE_URL      absolute URL of this service, used in the agent card
//   GRADE_SOURCE         base URL of the grade cache API
//   RPC_URL              JSON-RPC endpoint for live chain probes
//   CHAIN_ID             default 8453 (Base)

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
// Two supported shapes:
//   a2a    (default) POST JSON-RPC message/send to the measured-verdict peer and read its artifact
//   direct GET {GRADE_SOURCE}?address=...&chain=... and read a plain verdict JSON
const GRADE_SOURCE = (process.env.GRADE_SOURCE || "https://solene-fa2010da.base44.app/functions/a2a").replace(/\/$/, "");
const GRADE_SOURCE_MODE = process.env.GRADE_SOURCE_MODE || "a2a";
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
const VERSION = "1.0.0";

const TASKS = new Map(); // task id -> task object (Cloud Run instances are ephemeral; see README)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, A2A-Version",
};

function agentCard() {
  return {
    protocolVersion: "0.3.0",
    name: "On-chain Forensics",
    description:
      "Deterministic on-chain token grades, counterparty settlement checks, and supply audits for ERC-20 tokens on Base, Ethereum and Robinhood Chain. Answers come from a measured verdict cache; no model sits in the decision path.",
    url: PUBLIC_BASE_URL,
    preferredTransport: "JSONRPC",
    version: VERSION,
    provider: { organization: "Sanders & Sanders LLC", url: "https://onchainforensics.dev" },
    documentationUrl: "https://onchainforensics.dev/support.html",
    iconUrl: "https://onchainforensics.dev/logo.png",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false, extensions: [] },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    securitySchemes: {
      x402: { type: "http", scheme: "x402", description: "Live grading of an ungraded token is paid in USDC on Base at $0.02 per call." },
    },
    security: [],
    supportsAuthenticatedExtendedCard: false,
    skills: [
      { id: "token-verdict", name: "Token verdict", description: "Grade a token, with score, band and the measured window.", tags: ["crypto", "risk", "token"], examples: ["grade USDC on base", "is DEGEN safe to touch"], inputModes: ["text/plain"], outputModes: ["text/plain", "application/json"] },
      { id: "settle-safety", name: "Settlement safety", description: "Can this counterparty actually send or receive the token.", tags: ["crypto", "compliance"], examples: ["can this wallet receive USDC"], inputModes: ["text/plain"], outputModes: ["text/plain", "application/json"] },
    ],
  };
}

function cardV1() {
  const c = agentCard();
  return {
    name: c.name,
    description: c.description,
    supportedInterfaces: [{ url: c.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: c.provider,
    version: c.version,
    documentationUrl: c.documentationUrl,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: { x402: { httpAuthSecurityScheme: { scheme: "x402", description: c.securitySchemes.x402.description } } },
    securityRequirements: [],
    defaultInputModes: c.defaultInputModes,
    defaultOutputModes: c.defaultOutputModes,
    skills: c.skills,
    iconUrl: c.iconUrl,
  };
}

const V1_STATE = { submitted: "TASK_STATE_SUBMITTED", working: "TASK_STATE_WORKING", completed: "TASK_STATE_COMPLETED", failed: "TASK_STATE_FAILED", canceled: "TASK_STATE_CANCELED", "input-required": "TASK_STATE_INPUT_REQUIRED", rejected: "TASK_STATE_REJECTED", "auth-required": "TASK_STATE_AUTH_REQUIRED" };
const V1_ROLE = { user: "ROLE_USER", agent: "ROLE_AGENT" };

function toV1(v) {
  if (Array.isArray(v)) return v.map(toV1);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "kind" || k === "final") continue;
      if (k === "state" && V1_STATE[val]) { out[k] = V1_STATE[val]; continue; }
      if (k === "role" && V1_ROLE[val]) { out[k] = V1_ROLE[val]; continue; }
      out[k] = toV1(val);
    }
    return out;
  }
  return v;
}

const textOf = (msg) => (msg?.parts || []).map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ").trim();
const ADDR = /0x[a-fA-F0-9]{40}/;

async function rpc(method, params) {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

// Reads happen in-container: this is the compute plane the marketplace review asks about.
async function liveChainProbe(address) {
  try {
    const [code, supply] = await Promise.all([
      rpc("eth_getCode", [address, "latest"]),
      rpc("eth_call", [{ to: address, data: "0x18160ddd" }, "latest"]),
    ]);
    const hasCode = typeof code === "string" && code.length > 2;
    return { chain_id: CHAIN_ID, has_code: hasCode, has_code_bytes: hasCode ? (code.length - 2) / 2 : 0, total_supply_atomic: supply && supply !== "0x" ? BigInt(supply).toString() : null, source: "container_rpc" };
  } catch (e) {
    return { chain_id: CHAIN_ID, error: String(e.message || e).slice(0, 120), source: "container_rpc" };
  }
}

async function verdictLookup(question) {
  const address = (question.match(ADDR) || [])[0];
  if (!address) return { status: "NEED_ADDRESS", sentence: "Send a token address (0x...) or a symbol with a chain, and I will return the measured verdict." };
  let v = null;
  try {
    if (GRADE_SOURCE_MODE === "a2a") {
      const r = await fetch(GRADE_SOURCE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "message/send",
          params: { message: { role: "user", messageId: randomUUID(), parts: [{ kind: "text", text: `grade ${address} on base` }] } },
        }),
      });
      const j = await r.json();
      const parts = j?.result?.artifacts?.[0]?.parts || [];
      v = parts.find((p) => p && p.data)?.data || null;
      if (!v && parts[0]?.text) return { status: "NOT_CACHED", sentence: parts[0].text };
    } else {
      const r = await fetch(`${GRADE_SOURCE}?address=${address}&chain=base&trial=1`, { headers: { accept: "application/json" } });
      const j = await r.json();
      v = j.verdict || j;
    }
  } catch (e) {
    return { status: "CACHE_UNAVAILABLE", sentence: "The verdict cache is unreachable from this instance right now.", error: String(e.message || e) };
  }
  if (v && v.grade) {
    const sentence = `${v.symbol || address} on ${v.chain || "base"} grades ${v.grade} with a score of ${v.score}/100${v.reason ? ` (${v.reason})` : ""}.`;
    return { status: "GRADED", sentence, data: v };
  }
  return { status: "NOT_CACHED", sentence: `No measured verdict for ${address} yet. A live grade is available at $0.02 per call over x402 on Base.`, data: v };
}

function buildTask(id, contextId, state, sentence, data, question) {
  return {
    kind: "task",
    id,
    contextId,
    status: { state, timestamp: new Date().toISOString() },
    history: [{ kind: "message", messageId: randomUUID(), role: "user", parts: [{ kind: "text", text: question }] }],
    artifacts: [{ artifactId: randomUUID(), name: "token-verdict", description: sentence, parts: [{ kind: "text", text: sentence }, { kind: "data", data }] }],
    metadata: { served_by: "cloudrun", version: VERSION },
  };
}

function send(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...CORS, ...extraHeaders });
  res.end(body);
}
const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const sse = (res, events) => {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store", ...CORS });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end();
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_BASE_URL);
  const wantsV1 = (req.headers["a2a-version"] || "").trim() === "1.0";

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  if (req.method === "GET") {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true, service: "onchain-forensics-a2a", version: VERSION, compute: "cloud_run", chain_probe: await liveChainProbe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") });
    if (url.pathname === "/v1/card" || wantsV1) return send(res, 200, cardV1());
    return send(res, 200, agentCard());
  }

  if (req.method !== "POST") return send(res, 405, { error: "Use GET for the agent card or POST for JSON-RPC." });

  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 200, rpcErr(null, -32700, "Parse error: body is not valid JSON.")); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 200, rpcErr(null, -32600, "Invalid Request: send a single JSON-RPC 2.0 object."));

  const method = typeof body.method === "string" ? body.method : "";
  const id = body.id ?? null;
  const params = body.params || {};
  const v1 = wantsV1 || /^[A-Z]/.test(method);
  const q = textOf(params.message);

  if (method === "message/send" || method === "SendMessage") {
    if (!q) return send(res, 200, rpcErr(id, -32602, "Invalid params: message.parts carries no text."));
    const v = await verdictLookup(q);
    const address = (q.match(ADDR) || [])[0];
    const data = { ...v.data, live_probe: address ? await liveChainProbe(address) : undefined };
    const task = buildTask(randomUUID(), params.message?.contextId || randomUUID(), v.status === "CACHE_UNAVAILABLE" ? "failed" : "completed", v.sentence, data, q);
    TASKS.set(task.id, task);
    return send(res, 200, rpcOk(id, v1 ? toV1(task) : task));
  }

  if (method === "message/stream" || method === "SendStreamingMessage") {
    if (!q) return send(res, 200, rpcErr(id, -32602, "Invalid params: message.parts carries no text."));
    const v = await verdictLookup(q);
    const state = v.status === "CACHE_UNAVAILABLE" ? "failed" : "completed";
    const task = buildTask(randomUUID(), params.message?.contextId || randomUUID(), state, v.sentence, v.data, q);
    TASKS.set(task.id, task);
    const events = [
      { kind: "status-update", taskId: task.id, contextId: task.contextId, status: { state: "working", timestamp: new Date().toISOString() }, final: false },
      { kind: "artifact-update", taskId: task.id, contextId: task.contextId, artifact: task.artifacts[0], lastChunk: true },
      { kind: "status-update", taskId: task.id, contextId: task.contextId, status: { state, timestamp: new Date().toISOString() }, final: true },
    ].map((e) => rpcOk(id, v1 ? toV1(e) : e));
    return sse(res, events);
  }

  if (method === "tasks/get" || method === "GetTask") {
    const tid = params.id || params.taskId;
    if (!tid) return send(res, 200, rpcErr(id, -32602, "Invalid params: id is required."));
    const t = TASKS.get(String(tid));
    if (!t) return send(res, 200, rpcErr(id, -32001, `Task not found: ${tid}`));
    return send(res, 200, rpcOk(id, v1 ? toV1(t) : t));
  }

  if (method === "tasks/cancel" || method === "CancelTask") {
    const tid = params.id || params.taskId;
    const t = TASKS.get(String(tid));
    if (!t) return send(res, 200, rpcErr(id, -32001, `Task not found: ${tid}`));
    return send(res, 200, rpcErr(id, -32002, `Task not cancelable: it is already ${t.status.state}. This agent answers synchronously.`));
  }

  if (method === "ListTasks") {
    const tasks = [...TASKS.values()].slice(-50).map(toV1);
    return send(res, 200, rpcOk(id, { tasks, nextPageToken: "" }));
  }

  if (method === "tasks/resubscribe" || method === "SubscribeToTask") {
    const t = TASKS.get(String(params.id || params.taskId));
    if (!t) return send(res, 200, rpcErr(id, -32001, "Task not found."));
    return sse(res, [
      { kind: "artifact-update", taskId: t.id, contextId: t.contextId, artifact: t.artifacts[0], lastChunk: true },
      { kind: "status-update", taskId: t.id, contextId: t.contextId, status: { state: t.status.state, timestamp: t.status.timestamp }, final: true },
    ].map((e) => rpcOk(id, v1 ? toV1(e) : e)));
  }

  if (/pushnotificationconfig/i.test(method)) return send(res, 200, rpcErr(id, -32003, "Push notifications are not supported: this agent declares pushNotifications false and answers synchronously."));
  if (method === "GetExtendedAgentCard" || method === "agent/getAuthenticatedExtendedCard") return send(res, 200, rpcOk(id, v1 ? cardV1() : agentCard()));

  return send(res, 200, rpcErr(id, -32601, `Method not found: ${method}.`));
});

server.listen(PORT, () => console.log(`onchain-forensics a2a listening on :${PORT} (data: ${GRADE_SOURCE})`));
