#!/usr/bin/env bash
# One-shot Cloud Run deploy for the On-chain Forensics A2A endpoint.
# Requires: gcloud CLI authenticated as an account with Owner/Editor on the project,
# and billing enabled on that project.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to the Google Cloud project id}"
REGION="${REGION:-us-central1}"
SERVICE="onchain-forensics-a2a"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 20 \
  --memory 512Mi \
  --set-env-vars "GRADE_SOURCE=https://solene-fa2010da.base44.app/functions/a2a,GRADE_SOURCE_MODE=a2a,RPC_URL=https://mainnet.base.org"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_BASE_URL=$URL"

echo
echo "A2A endpoint: $URL"
echo "Agent card:   $URL/.well-known/agent-card.json"
echo "Health:       $URL/healthz"
