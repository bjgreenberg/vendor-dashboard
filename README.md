# RHR Vendor System Status Dashboard

A Google Apps Script / Node.js project that monitors the live status of RHR International's SaaS vendor ecosystem by polling each vendor's public status API and writing the results to a Google Sheet.

## Purpose

Provides a single-pane view of operational health across 25+ vendors — 1Password, Alteryx, Apple, Calendly, Celigo, Cloudflare, Concur, Docusign, Freshdesk/Freshservice, GitHub, Google Workspace, HubSpot, Jamf, KnowBe4, Microsoft, Monday.com, Okta, Seismic, Zoom, and more.

## Tech Stack

- **Runtime:** Google Apps Script (V8)
- **Output:** Google Sheets (`Vendor System Status` tab)
- **Status sources:** Statuspage v2 API, StatusGator scraping, vendor-specific APIs
- **Dev tooling:** `@types/google-apps-script` for IDE type support

## Prerequisites

- Google Workspace account with Apps Script access
- [clasp](https://github.com/google/clasp) for local development (`npm install -g @google/clasp`)
- Node.js (for type checking / dev tooling only — not used at runtime)

## Setup

1. Clone the repo and install dev dependencies:
   ```bash
   git clone git@github.com:bjgreenberg/vendor-dashboard.git
   cd vendor-dashboard
   npm install
   ```
2. Authenticate clasp:
   ```bash
   clasp login
   ```
3. Link to your Apps Script project:
   ```bash
   clasp clone <scriptId>
   # or push to existing project:
   clasp push
   ```
4. In Apps Script → Project Settings, confirm the script is bound to the correct Google Sheet.
5. Set up a time-based trigger to run `fetchAllStatuses` on your desired schedule (e.g. every 15 minutes).

## Secrets

No API keys are hardcoded. Any credentials required by specific vendor APIs should be stored in Apps Script **Script Properties** (Project Settings → Script Properties), not in source code.

## Project Structure

| File | Purpose |
|------|---------|
| `Code.js` | Main script — `FEEDS` config + all status fetch/parse logic |
| `appsscript.json` | Apps Script manifest |
| `package.json` | Dev dependencies (`@types/google-apps-script`) |
| `.gitignore` | Excludes `node_modules/`, `.clasp.json`, `creds.json` |

## Known Issues

- `npm` symlink is broken on the dev machine (`/opt/homebrew/opt/npm` points to a missing Cellar path). Run `brew reinstall node` to fix before running `npm audit`.
- `jsconfig.json.` has a trailing dot in the filename — likely a typo; rename to `jsconfig.json` if IDE support is needed.

## CI

Every pull request, and every push to `main`, runs the `test` job of the CI
workflow ([.github/workflows/ci.yml](.github/workflows/ci.yml)):

- `node --check` on every tracked `.js` file (syntax gate — Apps Script code
  has no unit tests yet)
- `npm audit --audit-level=high` against the committed lockfile

## Branch protection

PR flow per senior-engineering-partner v2.9: `main` is protected — changes go
branch → PR → merge. The `test` CI check is required: PRs cannot merge until
it passes. Linear history, enforced for admins.
