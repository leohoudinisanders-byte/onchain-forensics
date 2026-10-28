#!/usr/bin/env python3
# Spec v2.8.0 patch — Circle review round 2 (case 00163915)
import json

d = json.load(open("openapi.json"))
d["info"]["version"] = "2.8.0"

EVM = ["base", "ethereum"]
XRP_CH = ["base", "ethereum", "xrp"]
ADDR_ANY = "^0x[a-fA-F0-9]{40}$|^r[a-zA-Z0-9]{15,40}$"
ADDR_EVM = "^0x[a-fA-F0-9]{40}$"

P = d["paths"]

def set_200(path, ref):
    P[path]["get"]["responses"]["200"]["content"]["application/json"]["schema"] = {"$ref": "#/components/schemas/" + ref}

def param(name, desc, schema, required=False):
    return {"name": name, "in": "query", "required": required, "description": desc, "schema": schema}

# ---- dedicated route descriptions + params (no legacy endpoint= wording) ----

P["/functions/forensicsToken"]["get"]["description"] = (
    "Token burn/mint forensics: exact 24h net supply change plus recent mint/burn events for any ERC-20 "
    "on Base or Ethereum mainnet. EVM only (XRPL issuers are not supported on this route). "
    "REQUIRED INPUT: exactly one of token (named alias) or contract (0x contract address); chain defaults to base. "
    "Data-quality: incomplete log reads return null activity counts with activity_status PARTIAL_LOGS/UNAVAILABLE_SILENT_EMPTY_LOGS "
    "(zeros are never used to assert inactivity); supply-read failures are reported via supply_read_status and data_quality "
    "(ok, degraded_logs, ok_partial_supply, degraded_logs_partial_supply). evaluated_blocks carries the block range and window "
    "so results are reproducible."
)
tp = P["/functions/forensicsToken"]["get"]["parameters"]
for prm in tp:
    if prm["name"] == "chain":
        prm["schema"]["enum"] = EVM
        prm["description"] = "EVM chain (Ethereum L2 Base or Ethereum mainnet). token endpoint supports EVM only; XRPL is not supported here."
    if prm["name"] == "token":
        prm["description"] = "Named token alias (required unless contract is given). Exactly one of token or contract must be provided."
    if prm["name"] == "contract":
        prm["description"] = "ERC-20 contract address (required unless token alias is given). Exactly one of token or contract must be provided."

P["/functions/forensicsWallet"]["get"]["description"] = (
    "Wallet forensics: balance, transaction count, recent ERC-20 flows, top counterparties and a machine-readable "
    "trust tier (TRUSTED_ACTIVITY / LIGHT_ACTIVITY / NO_RECENT_ACTIVITY / SUSPICIOUS / EMPTY / CONTRACT_ADDRESS / ISSUER_ACCOUNT "
    "for XRPL) on Base, Ethereum or XRPL. REQUIRED INPUT: address (0x EVM address, or r... classic XRPL address; "
    "X-addresses are rejected with a hint). chain defaults to base; chain=xrp screens an XRPL account."
)
wp = P["/functions/forensicsWallet"]["get"]["parameters"]
for prm in wp:
    if prm["name"] == "address":
        prm["required"] = True
        prm["schema"]["pattern"] = ADDR_ANY
        prm["description"] = "Wallet address. REQUIRED. EVM: 0x 40-hex. XRPL: classic r-address (X-addresses rejected with a hint)."
    if prm["name"] == "chain":
        prm["description"] = "Chain: base (default), ethereum, or xrp (XRPL account screen)."

P["/functions/forensicsVerdict"]["get"]["description"] = (
    "Token verdict card: deterministic tier (e.g. RED_HOT / ACTIVE / DORMANT / NOT_A_CONTRACT / UNKNOWN), 0-100 activity "
    "score, red flags and a plain-language take, on Base, Ethereum or XRPL. REQUIRED INPUT: address (EVM token contract, "
    "or XRPL issuer r-address with chain=xrp; currency required for XRPL issuers). Incomplete log reads return UNKNOWN tier with "
    "LOGS_UNAVAILABLE and null activity counts, never a false DORMANT; evaluated_blocks carries the reproducible block range."
)
vp = P["/functions/forensicsVerdict"]["get"]["parameters"]
for prm in vp:
    if prm["name"] == "address":
        prm["required"] = True
        prm["schema"]["pattern"] = ADDR_ANY
        prm["description"] = "Token contract (EVM) or issuer address (XRPL). REQUIRED."
    if prm["name"] == "chain":
        prm["description"] = "Chain: base (default), ethereum, or xrp (issuer verdict)."
    if prm["name"] == "currency":
        prm["description"] = "XRPL only (chain=xrp): the issued currency code or hex (e.g. USD, RLUSD). Required for XRPL verdicts."

sp = P["/functions/forensicsSettlesafe"]["get"]["parameters"]
P["/functions/forensicsSettlesafe"]["get"]["description"] = (
    "Settle-safe pre-trade screen: canonical-asset check against the verified registry (KNOWN_CANONICAL / UNVERIFIED / "
    "NOT_A_CONTRACT / NOT_ERC20_READABLE / SYMBOL_MISMATCH) with optional counterparty wallet trust screen, on Base, "
    "Ethereum or XRPL. REQUIRED INPUT: for EVM, exactly one of token (alias) or address (0x contract); for XRPL "
    "(chain=xrp), issuer r-address plus currency (or token alias). counterparty is optional and adds the wallet trust screen."
)
for prm in sp:
    if prm["name"] == "address":
        prm["schema"]["pattern"] = ADDR_ANY
        prm["description"] = "Token contract address (EVM) or issuer address (XRPL). Required unless token alias is given."
    if prm["name"] == "token":
        prm["description"] = "Named token alias. Required unless address is given (alternatives)."
    if prm["name"] == "counterparty":
        prm["description"] = "Optional wallet address; adds the counterparty trust tier to the screen."
    if prm["name"] == "currency":
        prm["description"] = "XRPL only: issued currency code (required for XRPL issuers without a token alias)."
    if prm["name"] == "chain":
        prm["description"] = "Chain: base (default), ethereum, or xrp (issuer screen)."

P["/functions/forensicsMemo"]["get"]["description"] = (
    "Token due-diligence memo: composes the verdict card, 24h supply forensics and the settle-safe screen into one "
    "deterministic memo with a severity-ranked red-flag table and a bottom-line recommendation (same block = same memo; "
    "no LLM calls). REQUIRED INPUT: address (EVM token contract, or XRPL issuer with chain=xrp + currency). "
    "counterparty is optional ($0.35 tier) and adds the counterparty trust screen. Each section reports its own quality "
    "via section_quality, and incomplete reads are marked unavailable/partial rather than zero."
)
mp = P["/functions/forensicsMemo"]["get"]["parameters"]
for prm in mp:
    if prm["name"] == "address":
        prm["required"] = True
        prm["schema"]["pattern"] = ADDR_ANY
        prm["description"] = "Token contract (EVM) or issuer address (XRPL). REQUIRED."
    if prm["name"] == "chain":
        prm["description"] = "Chain: base (default), ethereum, or xrp (issuer memo)."
    if prm["name"] == "counterparty":
        prm["description"] = "Optional wallet address; upgrades to the $0.35 tier and adds the counterparty trust screen."

P["/functions/forensicsSweep"]["get"]["description"] = (
    "Portfolio sweep: screens a wallet's holdings across the curated registry (RWA, tokenized equities, blue chips) with the "
    "same verdict engine as the verdict route - identical windows, tier thresholds and scores; there is no intentional "
    "difference in metric definitions. Incomplete log reads return UNKNOWN (never false DORMANT); each holding carries "
    "activity_status and evaluated_blocks so consumers can compare and reproduce results. A zero-holding sweep does not "
    "mean the wallet is empty (registry coverage note included in the response)."
)
swp = P["/functions/forensicsSweep"]["get"]["parameters"]
for prm in swp:
    if prm["name"] == "address":
        prm["required"] = True
        prm["schema"]["pattern"] = ADDR_EVM
        prm["description"] = "Wallet address (0x, EVM only). REQUIRED."
    if prm["name"] == "chain":
        prm["schema"]["enum"] = EVM
        prm["description"] = "EVM chain: base (default) or ethereum. XRPL is not supported on this route."

# Canton / Linea: no operation parameters
for path in ("/functions/forensicsCanton", "/functions/forensicsLinea"):
    P[path]["get"]["parameters"] = []
P["/functions/forensicsCanton"]["get"]["description"] = (
    "Canton Network (CC) burn/mint snapshot: cumulative totals, twice-daily deltas, burn/mint ratios, net emission and 7d "
    "averages, cross-checked against live Noves Canton public data (cc_price, marker earnings, validator/asset counts; "
    "preapproval-fee watch). No operation parameters. Canton is a permissioned network: public metrics arrive via scheduled "
    "entity snapshots (refreshed twice daily at 07:30/19:30 CT) plus the live Noves cross-check, so emission figures are "
    "snapshot-derived rather than null-by-design gaps."
)
P["/functions/forensicsLinea"]["get"]["description"] = (
    "Linea (LINEA) burn snapshot: cumulative burn, 24h delta and scan metadata, refreshed daily by an entity workflow "
    "(snapshot cadence documented in scan_time). No operation parameters."
)

# Legacy generic route keeps the union response + endpoint param, description clarified
P["/functions/forensicsApi"]["get"]["description"] = (
    "LEGACY generic route (kept for existing integrations): all operations via ?endpoint=<name>. New integrations should "
    "use the dedicated per-operation routes (/functions/forensicsToken, .../forensicsVerdict, etc.), which advertise their "
    "own 402 payment metadata, input schemas and typed responses. Bare calls return the $0.02 directory tier."
)

# ---- per-route typed 200 responses ----
set_200("/functions/forensicsToken", "TokenResponse")
set_200("/functions/forensicsWallet", "WalletResponse")
set_200("/functions/forensicsVerdict", "VerdictResponse")
set_200("/functions/forensicsSettlesafe", "SettleSafeResponse")
set_200("/functions/forensicsMemo", "MemoResponse")
set_200("/functions/forensicsSweep", "SweepResponse")
set_200("/functions/forensicsCanton", "CantonResponse")
set_200("/functions/forensicsLinea", "LineaResponse")

# ---- component schema updates ----
S = d["components"]["schemas"]

S["TokenResponse"] = {
    "type": "object",
    "description": "Token burn/mint forensics response (token route). Incomplete log reads withhold activity counts (null) instead of asserting zero inactivity; supply-read failures are surfaced via supply_read_status and data_quality.",
    "properties": {
        "endpoint": {"type": "string", "const": "token"},
        "chain": {"type": "string"},
        "contract": {"type": "string"},
        "token_name": {"type": ["string", "null"]},
        "token_symbol": {"type": ["string", "null"]},
        "decimals": {"type": ["integer", "null"]},
        "total_supply_now": {"type": ["string", "null"], "description": "Raw integer string; null when the supply read failed."},
        "total_supply_24h_ago": {"type": ["string", "null"]},
        "net_supply_change_24h": {"type": ["string", "null"]},
        "net_supply_change_pct_24h": {"type": ["number", "null"]},
        "mints_24h": {"type": "object", "properties": {"count": {"type": ["integer", "null"]}, "volume": {"type": ["string", "null"]}}},
        "burns_24h": {"type": "object", "properties": {"count": {"type": ["integer", "null"]}, "volume": {"type": ["string", "null"]}}},
        "recent_activity_window_min": {"type": "integer"},
        "transfers_recent": {"type": ["integer", "null"], "description": "Null when log reads were incomplete."},
        "unique_wallets_recent": {"type": ["integer", "null"], "description": "Null when log reads were incomplete."},
        "mints_recent": {"type": ["object", "null"], "properties": {"count": {"type": ["integer", "null"]}, "volume": {"type": ["string", "null"]}, "status": {"type": "string", "enum": ["ok", "partial"]}}},
        "burns_recent": {"type": ["object", "null"], "properties": {"count": {"type": ["integer", "null"]}, "volume": {"type": ["string", "null"]}, "status": {"type": "string", "enum": ["ok", "partial"]}}},
        "activity_status": {"type": "string", "enum": ["OK", "PARTIAL_LOGS", "UNAVAILABLE_SILENT_EMPTY_LOGS"]},
        "activity_note": {"type": "string", "description": "Present when activity counts were withheld due to incomplete reads."},
        "logs_batches_failed": {"type": "integer"},
        "supply_read_status": {"type": "string", "enum": ["ok", "partial", "unavailable"]},
        "data_quality": {"type": "string", "enum": ["ok", "degraded_logs", "ok_partial_supply", "degraded_logs_partial_supply"]},
        "evaluated_blocks": {"$ref": "#/components/schemas/EvaluatedBlocks"},
        "error": {"type": "string"}
    }
}

S["EvaluatedBlocks"] = {
    "type": "object",
    "description": "The exact block range evaluated, so consumers can compare and reproduce results.",
    "properties": {
        "latest_block": {"type": "integer"},
        "from_block": {"type": "integer"},
        "window_min": {"type": "integer"}
    }
}

S["VerdictResponse"] = {
    "type": "object",
    "description": "Deterministic token verdict card. Incomplete log reads return UNKNOWN tier with LOGS_UNAVAILABLE and null counts, never a false DORMANT.",
    "properties": {
        "verdict_tier": {"type": "string", "description": "e.g. RED_HOT, ACTIVE, LIGHT_ACTIVITY, DORMANT, NOT_A_CONTRACT, NOT_AN_ISSUER, UNKNOWN"},
        "activity_score_0_100": {"type": "integer"},
        "window_min": {"type": "integer"},
        "transfers_recent": {"type": ["integer", "null"], "description": "Null when log reads were incomplete."},
        "unique_wallets_recent": {"type": ["integer", "null"]},
        "mints_recent": {"type": ["integer", "null"]},
        "burns_recent": {"type": ["integer", "null"]},
        "largest_transfer": {"type": ["object", "null"]},
        "concentration_top_wallet_share": {"type": "number"},
        "flags": {"type": "array", "items": {"type": "string"}},
        "activity_status": {"type": "string", "enum": ["OK", "PARTIAL_LOGS", "UNAVAILABLE_SILENT_EMPTY_LOGS"]},
        "logs_batches_failed": {"type": "integer"},
        "evaluated_blocks": {"$ref": "#/components/schemas/EvaluatedBlocks"},
        "take": {"type": "string"}
    }
}

S["MemoResponse"] = {
    "type": "object",
    "description": "Composed due-diligence memo (verdict + supply forensics + settle-safe screen + red-flag table + bottom line). Each section carries its own quality status; incomplete reads are marked unavailable/partial rather than zero.",
    "properties": {
        "header": {"type": "object", "properties": {"generated": {"type": "string"}, "asset": {"type": "string"}, "chain": {"type": "string"}, "price_tier": {"type": "string"}, "memo_version": {"type": "string"}}},
        "executive_summary": {"type": "string"},
        "supply_forensics": {"type": ["object", "null"], "description": "TokenResponse-shaped section; may be {status: unavailable}."},
        "wallet_flows": {"type": ["object", "null"], "description": "Verdict-derived flows incl. evaluated_blocks; may be {status: unavailable}."},
        "settle_safe_screen": {"type": ["object", "null"], "description": "SettleSafeResponse-shaped section."},
        "red_flags": {"type": "array", "items": {"type": "object", "properties": {"severity": {"type": "string", "enum": ["CRITICAL", "HIGH", "MEDIUM", "WARN", "INFO"]}, "flag": {"type": "string"}, "detail": {"type": "string"}}}},
        "section_quality": {"type": "object", "description": "Per-section data quality: settlesafe, verdict_logs, supply.", "properties": {"settlesafe": {"type": "string"}, "verdict_logs": {"type": "string"}, "supply": {"type": "string"}}},
        "bottom_line": {"type": "object", "properties": {"recommendation": {"type": "string"}, "confidence": {"type": "string"}, "summary": {"type": "string"}}},
        "counterparty_screen": {"type": ["object", "null"], "description": "Present on the $0.35 tier."}
    }
}

S["SweepResponse"] = {
    "type": "object",
    "description": "Portfolio sweep across the curated registry, using the SAME verdict engine as the verdict route (no intentional difference in metric definitions).",
    "properties": {
        "endpoint": {"type": "string", "const": "sweep"},
        "wallet": {"type": "string"},
        "chain": {"type": "string"},
        "screen_count": {"type": "integer"},
        "metric_definitions": {"type": "string", "description": "States that holdings are scored by the same verdict engine as the verdict route, and that incomplete reads yield UNKNOWN, never DORMANT."},
        "holdings": {"type": "array", "items": {"type": "object", "properties": {
            "alias": {"type": "string"},
            "symbol": {"type": "string"},
            "contract": {"type": "string"},
            "balance_display": {"type": "number"},
            "verdict_tier": {"type": "string"},
            "activity_score_0_100": {"type": ["integer", "null"]},
            "activity_status": {"type": "string"},
            "transfers_recent": {"type": ["integer", "null"]},
            "flags": {"type": "array", "items": {"type": "string"}},
            "evaluated_blocks": {"$ref": "#/components/schemas/EvaluatedBlocks"},
            "screen_status": {"type": "string"}
        }}},
        "bottom_line": {"type": "object"},
        "note": {"type": "string"}
    }
}

json.dump(d, open("openapi.json", "w"), indent=2)
print("spec patched to", d["info"]["version"])
