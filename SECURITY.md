# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue for a security problem.

Report via a [GitHub private security advisory](https://github.com/bjgreenberg/vendor-dashboard/security/advisories/new)
— GitHub's private reporting form is the single intake channel for this
repository.

Please include reproduction steps and the affected file/line where possible. You
can expect an initial acknowledgement within a few days.

## Scope and threat model

This is a **Cloudflare Worker** that polls ~46 vendors' public status endpoints
on a cron, writes a normalized snapshot to **D1**, and serves a **public
dashboard** at `briangreenberg.net/service-status` plus a JSON API and a
`/health` probe. The trust boundaries, most exposed first:

1. **Vendor status content is untrusted input on a public page.** Incident
   titles, descriptions, component names, and URLs from ~46 third-party status
   pages are stored in D1 and replayed to every visitor. A compromised or
   sloppy vendor page is the stored-XSS vector here. Controls: every
   interpolated value is escaped on output (`esc()` in `src/worker/render.js`
   — no exceptions), vendor URLs pass an http/https allowlist (`safeUrl()`),
   no vendor HTML is ever rendered, and a per-response nonce-gated CSP
   (`default-src 'none'`, `frame-ancestors 'none'`) is the second line of
   defence. The CSP and headers are pinned by tests
   (`test/worker/scheduled.test.js`).
2. **The inbound surface is read-only and unauthenticated by design.** GET
   endpoints only: the dashboard, `/api/status`, `/health`. No user input is
   executed or persisted; there are no accounts, sessions, cookies, or forms.
   All D1 access is via bound parameters (`src/worker/storage.js`) — no string
   SQL assembly.
3. **Build-time fetchers trust nothing they download.** `fetch-logos.mjs`
   validates every download by **magic bytes** and refuses non-images — a bot
   wall once answered a favicon URL with its challenge page and the old
   header-trusting logic committed it (found by the gitleaks gate, PR #32).
   Shipped icons are re-validated by tests on every run.
4. **No runtime secrets exist.** The Worker authenticates to nothing; it reads
   public endpoints and its own bound D1 database. Deploy credentials
   (`wrangler` OAuth / `CLOUDFLARE_API_TOKEN`) live outside the repo;
   `.clasp.json` / `creds.json` are gitignored relics verified never
   committed.

## Automated security checks (CI)

Every pull request runs, as merge-blocking gates:

| Check | Tool | Covers |
|-------|------|--------|
| `secret-scan` | gitleaks (digest-pinned container) | secrets in git history + working tree |
| `test` | `npm audit --audit-level=high` | known-vulnerable dev dependencies |
| `test` | vitest coverage gate (per-file floors) | untested fail-closed branches |
| `test` | `wrangler deploy --dry-run` (lockfile-pinned) | bundling/binding errors |
| `cff-validate` | cffconvert (digest-pinned) | citation metadata integrity |
| `docs-render` | mermaid-cli (digest-pinned) | diagram render integrity |

`eslint` runs locally (`npm run lint`); its CI job is staged. **OpenSSF
Scorecard** (`.github/workflows/scorecard.yml`) assesses supply-chain posture
once the repository is public, and **Dependabot** (`.github/dependabot.yml`)
opens weekly update PRs for npm dev dependencies and GitHub Actions pins, with
the alert count held at zero. All GitHub Actions are pinned to full-length
commit SHAs; all CI containers are pinned by digest.

## Availability posture

This is a monitoring tool, so *its own* silent failure is a security-adjacent
concern (a stale board asserts stale facts). The governing rule — **an
unverifiable status is `unknown`, never `operational`** — is enforced across
null/malformed payloads, unrecognised vocabulary, non-200 responses, parse
failures, and empty boards, and pinned by fixture tests per adapter. `/health`
answers from `run_meta` (503 once collection stalls) and is probed by an
external dead-man monitor.

## Not in scope

There is no runtime npm dependency (the Worker bundles only its own source),
so Python/container scanners do not apply. The `qs`/stryker chain and similar
advisories affect **dev tooling only** and are still triaged to zero via
Dependabot + `npm audit`.
