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

## [2.4.0](https://github.com/bjgreenberg/vendor-dashboard/compare/v2.3.1...v2.4.0) (2026-08-26)


### Features

* add Coalition (Control) vendor via the Instatus adapter ([#98](https://github.com/bjgreenberg/vendor-dashboard/issues/98)) ([284974e](https://github.com/bjgreenberg/vendor-dashboard/commit/284974ed48d179cd5f2240b68d107b572c8ab786))
* add US Government composite vendor (Login.gov, SSA, cloud.gov) ([#100](https://github.com/bjgreenberg/vendor-dashboard/issues/100)) ([54041cc](https://github.com/bjgreenberg/vendor-dashboard/commit/54041cc63497a3cf7f4c546e6b5d72e3957f0efc))
* add VA APIs to the US Government composite ([#101](https://github.com/bjgreenberg/vendor-dashboard/issues/101)) ([9f445fa](https://github.com/bjgreenberg/vendor-dashboard/commit/9f445fac4459ef4656c252e150c1bc34f1694f4e))


### Bug Fixes

* fail closed on empty vote sets in three adapters ([#102](https://github.com/bjgreenberg/vendor-dashboard/issues/102)) ([97e93a8](https://github.com/bjgreenberg/vendor-dashboard/commit/97e93a80dfeed6426e943a73804aa35369bf4905))
* **seo:** status page title and description match outage-intent queries ([#103](https://github.com/bjgreenberg/vendor-dashboard/issues/103)) ([c37e556](https://github.com/bjgreenberg/vendor-dashboard/commit/c37e556fb31dded11124bd726c7584b4526358fe))

## [2.3.1](https://github.com/bjgreenberg/vendor-dashboard/compare/v2.3.0...v2.3.1) (2026-08-13)


### Bug Fixes

* grant the fix-proposal job the tools its prompt requires ([#94](https://github.com/bjgreenberg/vendor-dashboard/issues/94)) ([bcce5c5](https://github.com/bjgreenberg/vendor-dashboard/commit/bcce5c578934012339014c8d14bc5bf301f24b39))

## [2.3.0](https://github.com/bjgreenberg/vendor-dashboard/compare/v2.2.0...v2.3.0) (2026-08-13)


### Features

* add Zscaler via a Trust-portal adapter — eight production clouds, US vantage, services not PoPs ([#86](https://github.com/bjgreenberg/vendor-dashboard/issues/86)) ([ab5d331](https://github.com/bjgreenberg/vendor-dashboard/commit/ab5d33162d953bf422bec1cd057321790cd51222))
* AI fix-proposal job for endpoint-rot issues, gated on ANTHROPIC_API_KEY ([#89](https://github.com/bjgreenberg/vendor-dashboard/issues/89)) ([7a757c8](https://github.com/bjgreenberg/vendor-dashboard/commit/7a757c8a47cabba3aad6f6ad2e1f925fe9ae9132))
* declare the site's icon surface on the board; intrinsic dimensions on every img ([#76](https://github.com/bjgreenberg/vendor-dashboard/issues/76)) ([96c0ba9](https://github.com/bjgreenberg/vendor-dashboard/commit/96c0ba9ec501013b8e13f485fdba148849d7f633))
* endpoint-rot watchdog — streak tracking, deterministic diagnosis, self-filing issues ([#87](https://github.com/bjgreenberg/vendor-dashboard/issues/87)) ([048a7ea](https://github.com/bjgreenberg/vendor-dashboard/commit/048a7eacf0f2d41c7cfc4de04bccba91fb369e3d))
* theme-color meta on the board — matches the site's brand accent ([#78](https://github.com/bjgreenberg/vendor-dashboard/issues/78)) ([be44e40](https://github.com/bjgreenberg/vendor-dashboard/commit/be44e40849522f363c748c446a898cc443cdc454))


### Bug Fixes

* **deps:** bump nanoid past GHSA-2v37-7h3g-55p8 ([#85](https://github.com/bjgreenberg/vendor-dashboard/issues/85)) ([ad3d1e0](https://github.com/bjgreenberg/vendor-dashboard/commit/ad3d1e09d725a2b28fee851d71969c5f1107a753))
* grant id-token to the fix-proposal workflow — OIDC exchange requires it ([#91](https://github.com/bjgreenberg/vendor-dashboard/issues/91)) ([de24369](https://github.com/bjgreenberg/vendor-dashboard/commit/de24369656ffa30066403727043ca5656c881f35))
* repoint Anthropic to status.claude.com ([#88](https://github.com/bjgreenberg/vendor-dashboard/issues/88)) ([853b5bf](https://github.com/bjgreenberg/vendor-dashboard/commit/853b5bf724607a85a6a22f14b5f94115ce29e6c6))
* repoint SendGrid to Twilio's status page, scoped to the SendGrid components ([#84](https://github.com/bjgreenberg/vendor-dashboard/issues/84)) ([8364dd1](https://github.com/bjgreenberg/vendor-dashboard/commit/8364dd17519a290691297284af8c58c5651c2a0e))

## [2.2.0](https://github.com/bjgreenberg/vendor-dashboard/compare/v2.1.0...v2.2.0) (2026-08-05)


### Features

* **analytics:** report alongside the site — CF beacon + the site's consent gate ([#70](https://github.com/bjgreenberg/vendor-dashboard/issues/70)) ([f12ff60](https://github.com/bjgreenberg/vendor-dashboard/commit/f12ff604c25977bf3988bcfd00337be41ce3afed))
* **discord:** geographies inform, US regions vote (scope.regionGroups) ([#68](https://github.com/bjgreenberg/vendor-dashboard/issues/68)) ([ac15971](https://github.com/bjgreenberg/vendor-dashboard/commit/ac15971f485e8850ce5a947300c3dab0e48c98e6))


### Bug Fixes

* **config:** fetch OutSystems from the canonical statuspage.io host — the vanity domain 418s Cloudflare Workers ([#73](https://github.com/bjgreenberg/vendor-dashboard/issues/73)) ([0394e6b](https://github.com/bjgreenberg/vendor-dashboard/commit/0394e6b15ff747684de278a5e0448dff8753f503))
* harden the two CodeQL findings — full regex escape for region tokens, fixpoint tag stripping for BetterStack labels ([#74](https://github.com/bjgreenberg/vendor-dashboard/issues/74)) ([000efe9](https://github.com/bjgreenberg/vendor-dashboard/commit/000efe93f52b493ffc9012bf63b4de618dc16ed3))
* HSTS on every /service-status response, bounded caching for static assets ([#71](https://github.com/bjgreenberg/vendor-dashboard/issues/71)) ([46e9bf0](https://github.com/bjgreenberg/vendor-dashboard/commit/46e9bf01862cda3418b0acee4ce06762f44454c2))
* **ui:** move the how-to note above the service board — it explained the rows only after you'd scrolled past all of them ([#72](https://github.com/bjgreenberg/vendor-dashboard/issues/72)) ([a655840](https://github.com/bjgreenberg/vendor-dashboard/commit/a655840ada8b5bc824db7ea18bab4191be4da845))

## [2.1.0](https://github.com/bjgreenberg/vendor-dashboard/compare/v2.0.0...v2.1.0) (2026-08-04)


### Features

* **aws:** US vantage point — foreign-region events inform the card, not the row ([#62](https://github.com/bjgreenberg/vendor-dashboard/issues/62)) ([41ff8a0](https://github.com/bjgreenberg/vendor-dashboard/commit/41ff8a03adbb75bb3f0662f5955fe64f3bb8953a))
* **ui:** tab-return refresh — never stale when you look, never yanked while you read ([#56](https://github.com/bjgreenberg/vendor-dashboard/issues/56)) ([7cdf671](https://github.com/bjgreenberg/vendor-dashboard/commit/7cdf671d9cea244b333401bce0b9832f9dbc4169))
* US vantage point — scoped regions vote on severity, the rest informs (operator decision) ([#61](https://github.com/bjgreenberg/vendor-dashboard/issues/61)) ([ce6dcfc](https://github.com/bjgreenberg/vendor-dashboard/commit/ce6dcfc9e8f05b5b188c360bf56ed6adb37439d0))


### Bug Fixes

* monitor probes the Worker directly; pin patched undici (two GitHub failures) ([#67](https://github.com/bjgreenberg/vendor-dashboard/issues/67)) ([9f5da81](https://github.com/bjgreenberg/vendor-dashboard/commit/9f5da81fa84ab7cc7adef0cc077d532dd137b453))
* **statuspage:** group-mode components name the regions driving their status ([#59](https://github.com/bjgreenberg/vendor-dashboard/issues/59)) ([5d4df8b](https://github.com/bjgreenberg/vendor-dashboard/commit/5d4df8ba5694670bbfeef94d0ae5a7a5016e124b))
* **ui:** remove the per-row permalink glyph — twice-misread is a failed affordance ([#65](https://github.com/bjgreenberg/vendor-dashboard/issues/65)) ([40896ad](https://github.com/bjgreenberg/vendor-dashboard/commit/40896adb1bc20321935eae0d0dd35132bb0843a1))
* **ui:** the filter explains its matches instead of looking broken ([#66](https://github.com/bjgreenberg/vendor-dashboard/issues/66)) ([fa2bb48](https://github.com/bjgreenberg/vendor-dashboard/commit/fa2bb483b0ac4b582109ff7e1cd1ab7746adde22))

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
