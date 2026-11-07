# Cloud Run deployment (Google Cloud hosting compliance)

This directory packages the A2A endpoint as a container so the agent runs on Google Cloud,
which is what Cloud Marketplace hosting Pattern 8/9 asks for. It is the same protocol
surface as `functions/a2a` on Base44, verified against the official `a2a-sdk` models.

## What runs where

| Layer | Where |
|---|---|
| HTTP surface, JSON-RPC dispatch, task objects, SSE streaming | the container, on Cloud Run |
| Live chain reads (eth_getCode, totalSupply) | the container, over RPC (`/healthz` proves it) |
| Measured verdicts | the grade cache over HTTPS (`GRADE_SOURCE`) |

The verdict cache is the one remaining off-Google dependency. For a clean Pattern 8/9
answer, mirror the verdict table into Firestore or a Cloud Storage JSON snapshot and set
`GRADE_SOURCE_MODE=direct` with `GRADE_SOURCE` pointing at it. Tasks are held in memory so
a multi-instance deployment should also move `TASKS` to Firestore; `tasks/get` replay
across instances needs that.

## Deploy

```bash
export PROJECT_ID=sanders-and-sanders-prod     # whatever the new project id ends up as
export REGION=us-central1

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# build + deploy straight from source (Cloud Build builds the Dockerfile)
gcloud run deploy onchain-forensics-a2a \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 20 \
  --memory 512Mi \
  --set-env-vars "GRADE_SOURCE=https://solene-fa2010da.base44.app/functions/a2a,GRADE_SOURCE_MODE=a2a,RPC_URL=https://mainnet.base.org"

# the service URL is the agent url in the card; publish it
URL=$(gcloud run services describe onchain-forensics-a2a --region "$REGION" --format 'value(status.url)')
echo "A2A endpoint: $URL"

gcloud run services update onchain-forensics-a2a --region "$REGION" --update-env-vars "PUBLIC_BASE_URL=$URL"
```

`PUBLIC_BASE_URL` must be the `*.run.app` URL (or the custom domain) because the agent card
uses it as the agent's own `url`, and a validator will fetch the card from that origin.

## Verify after deploy

```bash
curl -s "$URL/healthz" | jq        # ok:true and a live chain_probe
curl -s "$URL/.well-known/agent-card.json" | jq .name
curl -s "$URL" | jq .url           # same origin as the card

curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","messageId":"1","parts":[{"kind":"text","text":"grade 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on base"}]}}}' | jq -r '.result.artifacts[0].parts[0].text'
```

Expected: `USDC on base grades A with a score of 94/100 ...`

## Local run

```bash
PORT=8080 node server.mjs
curl -s localhost:8080/healthz | jq
```

No dependencies, Node 20. `node --check server.mjs` is the whole lint.
