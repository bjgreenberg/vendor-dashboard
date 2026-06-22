# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
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
