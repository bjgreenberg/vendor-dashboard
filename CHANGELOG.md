# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on versioning.** v1.1.0 was the last release of the Apps Script line.
> The rewrite is v2.0.0 and is cut by release-please from the `feat!` commit
> that landed it — the release-please manifest deliberately reads `1.1.0`,
> because that is the last version actually released. It briefly read `2.0.0`,
> which made the tooling propose 3.0.0 and would have skipped a version number
> that has no artifact behind it.
>
> **Note on history.** Git history was squashed at v2.0.0. The prior 1.x line
> was a single-file Google Apps Script implementation; its source is preserved
> outside this repository (in its original internal deployment) and in a
> verified `git bundle` backup. Entries below start at the rewrite. Everything
> from here forward is append-only.

## [2.0.0] - 2026-07-31

Complete rewrite from a single-file Google Apps Script to a Cloudflare Worker.

The rewrite was driven by an extraction audit
([`docs/audit/2026-07-30-extraction-audit.md`](docs/audit/2026-07-30-extraction-audit.md))
which found **four independent sources of false green** — vendors reporting
"Operational" regardless of reality — with a single common cause: no test ever
asserted an adapter's output against a recorded payload.

### Added

- **Runtime-agnostic engine** (`src/engine/`) with `fetchFn` and `now()`
  injected, so every adapter is testable without a network or a Worker runtime.
- **Ordered severity model** — `major_outage > partial_outage > degraded >
  unknown > maintenance > operational` — replacing a binary
  Operational/Degraded that discarded the gradations vendors already publish.
  `unknown` deliberately outranks `operational`.
- **Component scoping** by group or exact name, with drift warnings when a
  configured name matches nothing live.
- **Roll-up with progressive disclosure** — healthy vendors collapse to one row;
  unhealthy ones break out only the affected children. Zoom publishes 283
  components.
- **Ten adapters**: Statuspage, Instatus, Google, Apple, Okta (Atom),
  Salesforce, Concur, SorryApp, Better Stack, Microsoft — each pinned against a
  recorded payload.
- **Bounded retry** with a run-wide budget, sized against the Workers free-plan
  50-subrequest ceiling.
- **D1 persistence** — snapshot replaced transactionally in one batch, plus an
  append-only history table.
- **Dashboard** with client-side search, severity-ordered rows, a persisted
  three-state System/Light/Dark control, skip link, and accessible markup.
- **Staleness banner** — the dead-man's switch for the collector itself.
- **146 tests**, all written red-first.

### Fixed

- **H1 — Microsoft was hardcoded green.** The adapter fetched the endpoint,
  discarded the result, and returned a literal `"Operational"` row; Microsoft
  had displayed healthy 100% of the time since the tool was written. Now parses
  the payload, and is labelled **"Microsoft (Consumer Services)"** because that
  endpoint omits Exchange, SharePoint, Entra, Intune and Defender.
- **H2 — the malformed-row guard caused the crash it existed to prevent.**
  `const rows` was reassigned, throwing a `TypeError` precisely when an adapter
  returned a bad row, so nothing was written and stale data persisted silently.
- **H3 — component scoping was inert.** Measured live in both directions:
  Cloudflare under-reported (46 non-operational components, almost all routine
  edge re-routing), KnowBe4 over-reported (an incident about their online store
  while the vendor's own indicator read `none`).
- **H4 — error handling failed open.** A network failure returned a row whose
  status column read `Operational`. All failure paths now yield `unknown`.
- **H6 — Stormboard was permanently green.** The vendor migrated to Better
  Stack; the fallback tested `/\boperational\b/` against the whole document — a
  word appearing 7 times in that markup regardless of status. Now parses the
  structural status marker and fails closed.
- **H7 — Concur was permanently green.** The status page became a client-side
  app serving an empty shell; the scraped strings appeared zero times, and the
  sanity guard passed because "Concur" sits in the shell's `<title>`. Now uses
  the JSON API the app itself calls.
- **M1** — severity gradations preserved, making severity-ordered sorting
  possible at all.
- **M2** — component-level outages are detected; the page indicator is read.
- **M3** — the snapshot write is transactional; a mid-write failure can no
  longer leave an empty board.
- **M4** — all vendor-supplied content is escaped on output, behind a strict CSP
  with a per-response nonce.
- **M5** — vendors are fetched concurrently with per-request deadlines.
- **L1–L4** — dead code removed, honest User-Agent, full header validation,
  config-drift detection.
- **An empty board no longer renders as "All systems operational."** Caught on
  the first live deploy: zero records means nothing was checked.

### Changed

- Deployment is `wrangler deploy`; the Apps Script `clasp push` flow is gone.
- Vendor configuration moved out of source entirely into
  `config/vendors.example.json`.
- CI gates on real unit tests and a build check rather than syntax validity.
- Served at `/service-status` rather than `/status`, which conventionally means
  "the status of this site".

### Removed

- **StatusGator**, a third-party aggregator, and with it Freshdesk, Freshservice
  and Paylocity — none publishes a public machine-readable status endpoint. A
  monitored row with no real data source reports health it never verified.
- `Code.js`, `appsscript.json`, `jsconfig.json` — the Apps Script
  implementation, fully superseded.

### Security

- Vendor incident text is treated as untrusted third-party input and escaped at
  the render boundary; strict CSP (`default-src 'none'`) with a per-response
  nonce.
- Only the canonical host is indexable; the `workers.dev` address serves
  `noindex` so it cannot compete as a duplicate.
- No credential has ever entered this repository's history — `.clasp.json` and
  `creds.json` are gitignored and were verified never committed.
