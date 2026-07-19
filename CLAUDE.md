# CLAUDE.md — vendor-dashboard

Agent guide for this repo. House-wide rules (Conventional Commits, no
Co-Authored-By, push after every commit, squash-merge, secrets in 1Password)
live in the global `~/.claude/CLAUDE.md`; this file is repo-specific.

## What this is

Google Apps Script (V8) project: polls 30+ SaaS vendors' public status APIs
and writes a normalized 10-column row set to a Google Sheet. Deliberately a
**single-file script** (`Code.js`) — `FEEDS`/`FILTERS`/`HEADERS` config, the
`refreshVendorStatus()` entry point, and all per-vendor adapters. Every
adapter call sits in its own `try/catch` so one vendor's outage degrades one
row, never the run; rows that don't match the 10-column schema are dropped.

## Deployment — this clone is NOT production

Production is the bound Apps Script project, deployed with `clasp push`
(config in the local, gitignored `.clasp.json`); a time-based trigger runs
`refreshVendorStatus()` there. Merging to `main` deploys nothing — git is
the source of truth, `clasp push` is the release act. No LaunchAgent runs
from this clone. Vendor API credentials (if ever needed) go in Apps Script
Script Properties, never in source.

## Gates — all four CI jobs must be green before squash-merge

`.github/workflows/ci.yml` on every PR and push to `main`:

- `test` — `node --check` on every tracked `.js` (no unit tests by design —
  Apps Script; `npm test` is an intentional no-op) + `npm audit
  --audit-level=high`
- `secret-scan` — gitleaks over full git history + working tree
- `cff-validate` — `CITATION.cff` against the CFF schema
- `docs-render` — `scripts/render-diagrams.sh` render-checks every Mermaid
  block; run it locally before a PR (needs Docker — OrbStack locally)

Releases are automated by release-please: never hand-tag; the commit type
drives the bump (`feat:` minor, `fix:` patch; `docs:`/`chore:` cut no
release). All GitHub Actions stay pinned to full-length commit SHAs.

## Settled decisions — don't re-derive

- `scripts/render-diagrams.sh` must stay **bash 3.2 compatible** (no
  `mapfile`; guard empty-array expansion under `set -u`) — stock macOS bash
  bit this on 2026-07-10; CI's bash 5 hides it.
- Release/Scorecard badges are **intentionally absent while the repo is
  private** (both services would render errors); re-add them per README
  "Going public" only when the repo flips public.
- OAuth scopes in `appsscript.json` are deliberately least-privilege
  (`spreadsheets.currentonly` + `script.external_request`) — don't let Apps
  Script auto-detect wider scopes.
- `AGENTS.md` is gitignored on purpose (local agent notes, not shipped).
