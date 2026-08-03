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

- **Config is not code.** The vendor list lives in `config/vendors.json`.
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
- **Okta has no public JSON API** (all of summary.json, index.json,
  history.atom and history.rss return 401). The adapter parses the incidents the
  page embeds as JSON, via `indexOf` + a linear bracket walk — NOT regex: the
  page is ~347 KB against a 10 ms CPU budget. Measured 0.58 ms.
- **Microsoft publishes no public per-workload enterprise health.** Verified
  from Microsoft's own feed: `status.cloud.microsoft` reports only when the
  admin centre itself is unreachable. Exchange/Entra/Intune/Defender health is
  tenant-scoped by design. Do not go looking again.
- **Adapters return EVERY component, healthy included** — the dashboard decides
  what to show. Returning only unhealthy ones breaks the expand-all disclosure
  (fixed 2026-07-31; the healthy-path early return had omitted them).
- **404 is retryable.** Unusual, but Microsoft's endpoint measured ~50%
  available. Bounded by an attempt cap and a run-wide budget.
- **Retries share a run-wide budget** — the Workers *free* plan caps subrequests
  at 50 per invocation; 34 vendors retrying twice would be 102.
- **Collection is SHARDED: 15 shards on a `* * * * *` (every-minute) cron**
  (each vendor still refreshed every 15 min — `shards × cron interval` IS the
  refresh promise on the page). Two free-plan ceilings forced this originally
  (50 subrequests, then the 10 ms CPU cap that stopped collection for 3.5 h on
  2026-08-01). **Workers Paid since 2026-08-02** (30 s CPU, 1,000 subrequests)
  removed the hard limits; sharding is retained deliberately — tiny
  invocations, per-vendor blast-radius isolation, battle-tested. One shard
  covers ~3 vendors; expensive vendors (AWS, IBM, Oracle, Concur, NetSuite)
  stay pinned to separate shards in config. `wrangler.jsonc` declares
  `limits.cpu_ms` on purpose: a plan lapse fails the deploy loudly.
  - `CRON_EVERY_MINUTES` in `src/worker/index.js` **must** match
    `triggers.crons`. Shard rotation is derived from the clock; a mismatch
    silently starves some shards forever.
  - **Never `DELETE FROM snapshot` wholesale** — a sharded run must delete only
    the vendors it checked, or it wipes the other two thirds of the board.
  - `run_meta` counts are computed **in SQL from the snapshot table**, not from
    the run: a shard only knows its own third.
- **The subrequest budget meters `fetchFn` itself**, not each call site.
  Metering call sites was the original defect: retries were counted while base
  attempts, fallbacks and advisory second calls were not, so nothing bounded the
  run. Wrapping the injected function means a new fetch site cannot escape it.
- **Budget exhaustion is an operator fault and must read as one.** It presented
  as 17 simultaneous vendor outages; nothing distinguished "we stopped asking"
  from "they are down". `run.budgetExhausted` and a leading `collector:` warning
  now make that explicit.
- **Never a bare word match on HTML.** Finding H6 was
  `/\boperational\b/.test(html)` against a whole document. Parse structure and
  fail closed.

## Gates — all must be green before merge

`.github/workflows/ci.yml` on every PR and push to `main`:

- `test` — `npm ci` + the full vitest suite with per-file coverage floors +
  `wrangler deploy --dry-run` build check + `npm audit --audit-level=high`
  (don't cite a test count here — it drifts; `npm test` prints the current one)
- `lint` — `npx eslint .` (required)
- `secret-scan` — gitleaks over full history and working tree
- `cff-validate` — `CITATION.cff` against the CFF schema
- `docs-render` — every Mermaid block renders (needs Docker; OrbStack locally)
- `perf` — per-shard parse-cost REGRESSION gate (required): fails a PR when a
  shard's parse exceeds a 150 ms envelope — the 23.3 MB-feed class of mistake
  — long before the paid plan's 30 s ceiling would care. CI-runner numbers
  read ~3–4x hotter than Apple-silicon local runs; the envelope accounts for
  that.

Run `npm test` locally before pushing. Every adapter is pinned against a
recorded payload in `test/fixtures/` — that is the gate that would have caught
H1, H6 and H7 before they shipped. Human-facing contribution rules live in
CONTRIBUTING.md; this file carries the agent-specific operating detail.

## Verifying a deploy — read the RIGHT log stream

`wrangler tail --status=error` shows **exceptions only**. The whole design of
this collector is to *fail closed without throwing*, so a run where every fetch
fails produces a clean board of `unknown` rows and an empty error tail. On
2026-07-31 that exact combination was used to declare the service healthy while
17 vendors were starving.

To actually verify a collection:

```sh
# 1. The collector's own verdict, unfiltered — NOT --status=error.
npx wrangler tail --format=json | grep -E 'collection_(complete|alert)'
# 2. The board's aggregate state, over more than one cron cycle.
curl -s https://briangreenberg.net/service-status/api/status \
  | python3 -c "import sys,json;from collections import Counter;d=json.load(sys.stdin);print(Counter(r['severity'] for r in d['records']))"
# 3. Freshness, machine-readable: 200 while the snapshot is <45 min old,
#    503 when collection has stopped or D1 is unreachable. This is what the
#    external dead-man monitor probes.
curl -sf https://briangreenberg.net/service-status/health
```

A single green reading right after a deploy proves nothing: the failure was
intermittent and cycle-dependent. Watch at least one full 15-minute cycle
(three shards) before calling it good.

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

`Apple` may report `unknown` when collecting from a host with **no IPv6
egress**: Node's fetch tries AAAA first, and Apple is the only configured
vendor publishing AAAA records. It resolves correctly from Cloudflare's
network. Do not "fix" the Apple adapter for this.

Machine-specific notes (shell aliases, host names) live in the maintainer's
gitignored `AGENTS.md`, not here.

## Releases

Automated by release-please; never hand-tag. Commit type drives the bump
(`feat:` minor, `fix:` patch, `feat!:`/`BREAKING CHANGE` major; `docs:`/`chore:`
cut no release). Version lives in `package.json`, `.release-please-manifest.json`
and `CITATION.cff` (annotated) — all bumped together by the tooling.

## Repository status

Visibility and the go-public checklist live in README → *Going public* — check
there rather than assuming; this file does not track visibility.

`main` is **fully protected**: required PR reviews, six required status checks
(`test`, `lint`, `docs-render`, `cff-validate`, `secret-scan`), linear history,
no force pushes, **enforced for admins**. Land work by PR — a direct push or
force-push is rejected with `protected branch hook declined`.

Note the two different APIs: `repos/{o}/{r}/rules/branches/main` returns `[]`
here because there are no *rulesets*; the protection is **classic**, at
`repos/{o}/{r}/branches/main/protection`. Checking only the first will tell you
the branch is unprotected when it is not. (The go-public checklist includes
moving reviews 0→1 via a ruleset with admin bypass — re-check this section's
accuracy after that lands.)

## Contact

Security reports: GitHub private security advisory only (see SECURITY.md).
Do not add a maintainer email address anywhere in this repository — the
GitHub advisory/issue system is the sole contact channel by explicit
maintainer decision (2026-08-02).
