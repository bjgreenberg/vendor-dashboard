#!/usr/bin/env bash
#
# deploy.sh — logos → D1 migrations → wrangler deploy, as one strict chain.
#
# The migrations step gets ONE bounded retry: Cloudflare's D1 REST endpoint
# intermittently rejects the account with `code: 7403` ("account is not
# valid or is not authorized") and succeeds on immediate retry — observed
# 2026-08-03 twice, first blamed on plan-activation propagation until it
# recurred a day later. The retry is deliberately narrow (that step only,
# once, loudly): everything else stays fail-fast, and a SECOND consecutive
# failure is a real error that must stop the deploy.
set -euo pipefail

node scripts/fetch-logos.mjs

if ! npx --no-install wrangler d1 migrations apply vendor-dashboard --remote; then
  echo "deploy.sh: D1 migrations failed once (known-flaky endpoint, see comment) — retrying in 5s..." >&2
  sleep 5
  npx --no-install wrangler d1 migrations apply vendor-dashboard --remote
fi

npx --no-install wrangler deploy
