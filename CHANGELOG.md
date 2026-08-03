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

## [2.0.0](https://github.com/bjgreenberg/vendor-dashboard/compare/v1.1.0...v2.0.0) (2026-08-03)


### ⚠ BREAKING CHANGES

* vendor status dashboard v2.0.0 — Apps Script to Cloudflare Worker ([#17](https://github.com/bjgreenberg/vendor-dashboard/issues/17))

### Features

* 2026-08-01 production line — CPU-ceiling sharding, Microsoft composite, AWS/IBM/Oracle onboarding ([#32](https://github.com/bjgreenberg/vendor-dashboard/issues/32)) ([30626d6](https://github.com/bjgreenberg/vendor-dashboard/commit/30626d6f5c54554160f45ed42fdfdc7b29083bb6))
* add Meta and Signal; document the rest of the social set ([#20](https://github.com/bjgreenberg/vendor-dashboard/issues/20)) ([60c66a1](https://github.com/bjgreenberg/vendor-dashboard/commit/60c66a1846454eb93fd88dc3bd30a512914d40cd))
* convert the Workers Paid plan into enforced reality (closes audit H2) ([#49](https://github.com/bjgreenberg/vendor-dashboard/issues/49)) ([294799f](https://github.com/bjgreenberg/vendor-dashboard/commit/294799f27af1f4a1ba8e8a7b4f25edf8386b4008))
* **deploy:** Deploy to Cloudflare button; schema becomes D1 migrations ([#51](https://github.com/bjgreenberg/vendor-dashboard/issues/51)) ([2282211](https://github.com/bjgreenberg/vendor-dashboard/commit/22822111f2c73df01a1efa7af0b25c8ffad450a2))
* **health:** /health answers from run_meta — freshness, D1 reachability, 503 when stale (audit H3, L3) ([#40](https://github.com/bjgreenberg/vendor-dashboard/issues/40)) ([2e87ac4](https://github.com/bjgreenberg/vendor-dashboard/commit/2e87ac45d728f6bda6ea5ab85c95271c26305ad6))
* self-hosted vendor logos; reject the Adobe lighter-touch ([#22](https://github.com/bjgreenberg/vendor-dashboard/issues/22)) ([9824fbf](https://github.com/bjgreenberg/vendor-dashboard/commit/9824fbf7774b454fb3cadebff2cfaa5de336a420))
* share card, social metadata and a share bar ([#27](https://github.com/bjgreenberg/vendor-dashboard/issues/27)) ([82225e8](https://github.com/bjgreenberg/vendor-dashboard/commit/82225e8a5d359c54e077c23f56f0b9fe40127b06))
* **share:** add Facebook, Threads and Mastodon to the share bar ([#29](https://github.com/bjgreenberg/vendor-dashboard/issues/29)) ([12ccf34](https://github.com/bjgreenberg/vendor-dashboard/commit/12ccf34441573502c53c8407dd25d19a4aec78d5))
* **ui:** default this page to dark; record Docusign watch and Freshworks ([#19](https://github.com/bjgreenberg/vendor-dashboard/issues/19)) ([d19aab3](https://github.com/bjgreenberg/vendor-dashboard/commit/d19aab3670b2a95bbaad3be18e0c015e26f2c1ee))
* vendor status dashboard v2.0.0 — Apps Script to Cloudflare Worker ([#17](https://github.com/bjgreenberg/vendor-dashboard/issues/17)) ([e8eacd3](https://github.com/bjgreenberg/vendor-dashboard/commit/e8eacd3cd01440124d37bc66478f6f7d2da55827))


### Bug Fixes

* **a11y:** dark-mode status colours failed WCAG 2.2 AA ([#21](https://github.com/bjgreenberg/vendor-dashboard/issues/21)) ([6b2d00e](https://github.com/bjgreenberg/vendor-dashboard/commit/6b2d00e2862587f753e6bc85816306a00c51b8dc))
* **collect:** every fetch gets a deadline — advisory calls could hang the shard (audit M3) ([#39](https://github.com/bjgreenberg/vendor-dashboard/issues/39)) ([eb80c28](https://github.com/bjgreenberg/vendor-dashboard/commit/eb80c28274f9a11e408d9c4eb6c9465545783fac))
* **collect:** shard collection so a run cannot exceed the subrequest ceiling ([#30](https://github.com/bjgreenberg/vendor-dashboard/issues/30)) ([e1f57f7](https://github.com/bjgreenberg/vendor-dashboard/commit/e1f57f7dc5d4c4ad712c7f519c6a7af3befc42cb))
* **microsoft:** fall back to a second endpoint ([#25](https://github.com/bjgreenberg/vendor-dashboard/issues/25)) ([cd54b8d](https://github.com/bjgreenberg/vendor-dashboard/commit/cd54b8d03535ac05f059df1aa60d2c40d5bfe8cc))
* **release:** manifest claimed a release that never happened ([#26](https://github.com/bjgreenberg/vendor-dashboard/issues/26)) ([29b8430](https://github.com/bjgreenberg/vendor-dashboard/commit/29b8430bc0ac2e23883fd184faa8904ea031eedd))
* render-diagrams gate runs on stock macOS bash 3.2 ([#9](https://github.com/bjgreenberg/vendor-dashboard/issues/9)) ([8881a98](https://github.com/bjgreenberg/vendor-dashboard/commit/8881a98e53880bdf86bda71427dcfbd24a3c34eb))
* **shard:** derive rotation from the epoch so it survives midnight at any count ([#31](https://github.com/bjgreenberg/vendor-dashboard/issues/31)) ([09e5479](https://github.com/bjgreenberg/vendor-dashboard/commit/09e547908ccba0b36c8e511e2037b9d165f415d1))
* **storage:** bound history growth — 90-day retention in the write batch (audit L4) ([#43](https://github.com/bjgreenberg/vendor-dashboard/issues/43)) ([85ec92a](https://github.com/bjgreenberg/vendor-dashboard/commit/85ec92a4b4e49eead113e1a820051474fafcc1c6))
* **ui:** logos on both themes, equal size, right of the name; widen intro ([#23](https://github.com/bjgreenberg/vendor-dashboard/issues/23)) ([5e6f978](https://github.com/bjgreenberg/vendor-dashboard/commit/5e6f978005e0ce7719d721fc47c47f468ae23e30))
* **ui:** marks lead the row and fill their chip ([#24](https://github.com/bjgreenberg/vendor-dashboard/issues/24)) ([d878e99](https://github.com/bjgreenberg/vendor-dashboard/commit/d878e998a12c5884f3280bb67325b46c98b9eb71))

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
