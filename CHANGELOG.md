# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed
- **Generalized the project into a vendor-neutral, public-ready open-source
  project** named **"Vendor Status Dashboard"**. The vendor `FEEDS` list is
  unchanged (all public status endpoints) and is now documented as a
  configurable example set.

### Added
- **Release automation with [release-please](https://github.com/googleapis/release-please)**
  — `release-please-config.json`, `.release-please-manifest.json`, and the
  `release-please` workflow (third-party action SHA-pinned). Version bumps,
  `CHANGELOG.md`, and `CITATION.cff` are driven by Conventional Commits; merging
  the release PR publishes a GitHub Release.
- **Apache-2.0 `LICENSE`** and a **`CITATION.cff`** (CFF 1.2.0) whose `version`
  and `date-released` are kept current by release-please via `extra-files`
  annotations.
- **Status badge row** in the README (CI, Release, License) plus new
  **Versioning & releases**, **Citing this project**, **Configuring vendors**,
  **Contributing**, **Going public**, and **License** sections.
- **Second and third README visuals** — a render-checked `stateDiagram-v2` of a
  single vendor row's lifecycle, and an output-schema data-dictionary table.
- **`.github/dependabot.yml`** — weekly `npm` + `github-actions` update PRs.
- **SHA-pinned every GitHub Action** (`actions/checkout`, `actions/setup-node`,
  `release-please-action`) to a full-length commit SHA — supply-chain integrity,
  and required by the repository's action-pinning policy. Dependabot
  (`github-actions`) keeps the pins current.
- **`secret-scan` CI gate** — gitleaks (digest-pinned container) over the full
  git history and working tree on every PR. Works while the repo is private.
- **OpenSSF Scorecard workflow + badge** (`.github/workflows/scorecard.yml`) —
  supply-chain posture analysis. Guarded on repo visibility, so it is a clean
  skip while private and auto-activates on the first push to `main` after the
  repo is made public. All Scorecard-workflow actions are SHA-pinned.
- **`SECURITY.md`** — vulnerability disclosure policy, threat model, and the CI
  security-gate matrix.

### Security
- **Declared explicit least-privilege `oauthScopes` in `appsscript.json`**
  (`spreadsheets.currentonly` + `script.external_request`) instead of relying on
  Apps Script scope auto-detection, which over-reaches. The script only uses
  `SpreadsheetApp` (active sheet) and `UrlFetchApp`.
  **Note:** adding explicit scopes forces re-authorization on the next `clasp
  push` / deploy. If the bound-sheet write ever fails, widen
  `spreadsheets.currentonly` → `spreadsheets`.

### Fixed
- **`package.json` metadata** — removed the bogus `node` **runtime** dependency
  (`node@^25.6.1`, a mistaken install), set `license` to `Apache-2.0`, and added
  `author`, `description`, `keywords`, `repository`, `bugs`, and `homepage`. The
  `test` script no longer exits non-zero for a project with no unit tests.
  Regenerated `package-lock.json` (2 packages, 0 vulnerabilities).

### Added (prior, unreleased)
- **Architecture data-flow diagram + a "How it works" section** in the README:
  a render-checked Mermaid `flowchart` of the trigger → `refreshVendorStatus()`
  → per-vendor adapter dispatch (Statuspage-v2 default + the custom adapters,
  each in its own `try/catch`) → normalize → validate column count → clear,
  write, multi-sort the Google Sheet.
- **`docs-render` CI job + `scripts/render-diagrams.sh`** — render-checks every
  ` ```mermaid ` block via the digest-pinned `mermaid-cli` container; promoted
  to a required status check alongside `test`.
- **`Last updated:` stamp** under the README H1.

### Fixed
- **Stale trigger name in the README.** Setup step 5 told users to schedule a
  trigger on `fetchAllStatuses`, which does not exist in `Code.js` — the actual
  entry point is `refreshVendorStatus()`. Corrected, and clarified the entry
  point in the Project Structure table.
- **Renamed `jsconfig.json.` → `jsconfig.json`** — the file had a stray trailing
  dot in its name, so editors never picked it up for Apps Script IDE type
  support. Content was already a valid jsconfig; only the filename was wrong.
  Removed the corresponding note from the README's Known Issues.

---

## 2026-06-10

### Added
- `ci`: GitHub Actions CI workflow (`test` job) — `node --check` on all tracked JS + `npm audit --audit-level=high`, every PR and push to `main`. README CI section updated; `test` becomes the required branch-protection check.

---

## 2026-02-22

### Changed
- Removed `AGENTS.md` from repository and added to `.gitignore`

---

## 2026-02-20

### Added
- 1Password, Tableau, Iorad, Okta status feeds
- StatusGator scraping for Freshdesk and Freshservice
- QuantumWorkplace status API URL
- Script to discover Freshworks API endpoints

### Changed
- Migrated NetSuite to Statuspage API
- Refined incident parsing for Concur and generic Statuspage feeds
- Improved Google Workspace status parsing using `status_impact` and `most_recent_update` fields
- Enhanced text cleaning for better readability
- Updated incident status logic

### Removed
- Obsolete Google test scripts
- `test-fresh.js`

---

## 2026-02-19

### Changed
- Sync update from home machine

---

## 2026-02-13

### Added
- Qualtrics feed enabled
- Initial commit from Antigravity (work machine)
