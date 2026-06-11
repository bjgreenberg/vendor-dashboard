# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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
