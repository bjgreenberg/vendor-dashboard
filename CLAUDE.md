# CLAUDE.md — vendor-dashboard

Agent guide for this repo. House-wide rules (Conventional Commits, no
Co-Authored-By, push after every commit, squash-merge, secrets in 1Password)
live in the global `~/.claude/CLAUDE.md`; this file is repo-specific.

## What this is

A Cloudflare Worker that polls ~34 SaaS/cloud vendors' public status endpoints
every 15 minutes, writes a snapshot to D1, and serves a dashboard at
`briangreenberg.net/service-status`.

Rewritten in v2.0.0 from a single-file Google Apps Script. The rewrite was
driven by an audit (`docs/audit/2026-07-30-extraction-audit.md`) that found
**four independent sources of false green**.

## The governing rule

**An unverifiable status is `unknown`, never `operational`.**

Every change must preserve this. A green row has to mean something was actually
verified. The audit exists because four separate mechanisms had quietly broken
that promise — and none of them crashed; they all just reported health.

Concretely, fail closed on: null payloads, malformed payloads, unrecognised
status vocabulary, non-200 responses, parse failures, an empty vendor list, and
an empty board.

## Architecture — the one boundary that matters

```
src/engine/   PURE. No Worker/GCP/Apps Script APIs. fetchFn and now() injected.
src/worker/   Cloudflare bindings ONLY.
```

Do not import a platform API into `src/engine/`. That boundary is what makes
every adapter testable against recorded fixtures with no network, and what keeps
a future non-Cloudflare deployment possible.

## Settled decisions — don't re-derive

- **Config is not code.** The vendor list lives in `config/vendors.example.json`.
  Never hardcode vendors in source.
- **Incidents inform context, never severity.** Deriving status from incidents
  caused errors in *both* directions: missed component-only outages, and marked
  KnowBe4 degraded over an incident about their online store while the vendor's
  own indicator read `none`.
- **A configured scope overrides the vendor's page indicator.** The operator has
  declared what matters. This is what lets Cloudflare read operational while 26
  edge PoPs re-route.
- **Cloudflare is scoped to services only** (decision D1) — PoP groups excluded.
- **Microsoft is labelled "Microsoft (Consumer Services)".** That endpoint has no
  Exchange/SharePoint/Entra/Intune/Defender. Never relabel it "Microsoft 365".
- **StatusGator is not used.** Freshdesk, Freshservice and Paylocity are omitted
  entirely because they publish no public endpoint. Do not re-add a row without
  a real data source.
- **Okta's Atom parsing uses targeted regex** to keep the engine
  dependency-free. It fails to `unknown` if markup changes. **Do not extend it
  into general XML handling.**
- **404 is retryable.** Unusual, but Microsoft's endpoint measured ~50%
  available. Bounded by an attempt cap and a run-wide budget.
- **Retries share a run-wide budget** — the Workers *free* plan caps subrequests
  at 50 per invocation; 34 vendors retrying twice would be 102.
- **Never a bare word match on HTML.** Finding H6 was
  `/\boperational\b/.test(html)` against a whole document. Parse structure and
  fail closed.

## Gates — all must be green before merge

`.github/workflows/ci.yml` on every PR and push to `main`:

- `test` — `npm ci` + 146 vitest tests + `wrangler deploy --dry-run` build check
  + `npm audit --audit-level=high`
- `secret-scan` — gitleaks over full history and working tree
- `cff-validate` — `CITATION.cff` against the CFF schema
- `docs-render` — every Mermaid block renders (needs Docker; OrbStack locally)

Run `npm test` locally before pushing. Every adapter is pinned against a
recorded payload in `test/fixtures/` — that is the gate that would have caught
H1, H6 and H7 before they shipped.

## Deployment gotchas

- ⚠️ **Deploys take 20–30 s to propagate.** Testing sooner yields convincing
  false 404s on correctly-configured paths. Cache-busting does not help — it is
  not caching. This cost three false debugging rounds on 2026-07-31.
- ⚠️ **Never declare `custom_domain` in `wrangler.jsonc`.** Wrangler skips the
  changeset preview and force-overrides DNS when stdout is not a TTY — on the
  zone the live site depends on. Routes are declared with `zone_name`.
- The `limits` block is **paid-plan only**; this account is on Workers Free.
  It is commented out, not deleted, with the free ceilings documented.
- `scripts/render-diagrams.sh` must stay **bash 3.2 compatible** (no `mapfile`;
  guard empty-array expansion under `set -u`) — stock macOS bash bit this on
  2026-07-10; CI's bash 5 hides it.

## Local environment note

`Apple` may report `unknown` when collecting from **socrates**: that host has no
IPv6 egress, Node's fetch tries AAAA first, and Apple is the only configured
vendor publishing AAAA records. It resolves correctly from Cloudflare's network.
Do not "fix" the Apple adapter for this.

Also: `cp` and `rm` are aliased to interactive. A scripted `cp` overwrite
silently does nothing and defaults to *no*. Use `command cp` or an explicit
editor write.

## Releases

Automated by release-please; never hand-tag. Commit type drives the bump
(`feat:` minor, `fix:` patch, `feat!:`/`BREAKING CHANGE` major; `docs:`/`chore:`
cut no release). Version lives in `package.json`, `.release-please-manifest.json`
and `CITATION.cff` (annotated) — all bumped together by the tooling.

## Repository status

**Private.** Release and Scorecard badges are intentionally absent (both would
render errors on a private repo); re-add per README → *Going public*.
`main` is currently **unprotected** — worth enabling before adding a second
writer or publishing.
