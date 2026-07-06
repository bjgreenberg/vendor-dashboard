# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue for a security problem.

- Preferred: open a [GitHub private security advisory](https://github.com/bjgreenberg/vendor-dashboard/security/advisories/new).
- Or email the maintainer: **bjg@acm.org**.

Please include reproduction steps and the affected file/line where possible. You
can expect an initial acknowledgement within a few days.

## Scope and threat model

This is a Google Apps Script tool that **reads public vendor status endpoints
over HTTPS and writes normalized rows to a Google Sheet** it is bound to. It:

- stores **no secrets in source** — any per-vendor credentials belong in Apps
  Script **Script Properties**, never in `Code.js`;
- makes only **outbound** requests to public status APIs (no inbound surface, no
  user-supplied input executed);
- declares **least-privilege OAuth scopes** in `appsscript.json`
  (`spreadsheets.currentonly` + `script.external_request`) rather than relying on
  Apps Script scope auto-detection.

External responses are treated as untrusted data: every adapter call is wrapped
in its own `try/catch`, and rows that don't match the fixed 10-column schema are
dropped rather than written.

## Automated security checks (CI)

Every pull request runs, as merge-relevant gates:

| Check | Tool | Covers |
|-------|------|--------|
| `secret-scan` | gitleaks (digest-pinned) | secrets in git history + working tree |
| `test` | `npm audit --audit-level=high` | known-vulnerable dev dependencies |
| `test` | `node --check` | JavaScript syntax validity |
| `cff-validate` | cffconvert (digest-pinned) | citation metadata integrity |
| `docs-render` | mermaid-cli (digest-pinned) | diagram render integrity |

Additionally, **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) assesses
supply-chain posture once the repository is public, and **Dependabot**
(`.github/dependabot.yml`) opens weekly update PRs for npm dev dependencies and
GitHub Actions pins. All GitHub Actions are pinned to full-length commit SHAs.

## Not in scope

There is no runtime dependency manifest (Apps Script has no npm runtime), so
tooling such as `bandit`/`pip-audit` (Python) and container image scanners do not
apply. `@types/google-apps-script` is a dev-only type package.
