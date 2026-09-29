# Truth check on hume — one script, two runners

**Date:** 2026-09-25 · **Status:** implemented (PR opened 2026-09-25) · **Extends:** [2026-09-05-truth-check-design.md](2026-09-05-truth-check-design.md)

## Problem

On 2026-09-24 the board read **"Truth check overdue — last verified … 7:46 PM"**
while nothing was wrong with the check. The truth-check workflow is a
GitHub-hosted `schedule:` job (`41 */2 * * *`); GitHub fired it at 18:38Z,
21:45Z and 00:45Z and then skipped the 02:41Z and 04:41Z slots. The board's
`TRUTH_STALE_AFTER_MS` (3 h) rule turned a **scheduling miss** into the same
banner a real verification gap would raise. GitHub's status page showed
Actions operational; the run history already showed 3–6 h gaps against a 2 h
schedule the day before. Cron on GitHub-hosted runners is best-effort by
design, and nothing on our side can make it exact.

The original design chose GitHub for independence from **Cloudflare** — a
monitor inside the Worker dies with the invocation it is trying to report on.
That reason is intact. It never required GitHub's *machines*; any runner
outside Cloudflare satisfies it, and the always-on Mac (hume) already runs the
board's 15-minute freshness probe from launchd, watched by health-monitor.

## Decision (Brian, 2026-09-25: option 3 of three)

1. **hume runs the check hourly as the primary** — an exact clock, a success
   stamp under health-monitor's dead man's switch.
2. **The GitHub workflow stays as the external backstop** — unchanged cadence,
   zero configuration for forks, an opinion that survives a hume outage.
3. **Both execute one script**, `scripts/truth-check/check.sh`, so the two
   runners cannot drift. The workflow's ~100 lines of inline bash moved into it
   verbatim (label → compare → 10-minute confirm → issues → stamp → summary).

Rejected: (a) hourly cron on GitHub alone — hides the flakiness, does not
remove it; (b) hume alone — loses the outside-the-fleet opinion and the fork
story.

## Contract

`check.sh` runs in the caller's scratch directory and reads its inputs from the
environment (`ORIGIN`, `GITHUB_REPOSITORY`, `GH_TOKEN`, optional
`TRUTH_CHECK_TOKEN` and `WATCHDOG_WEBHOOK_URL`, seam
`TRUTH_CHECK_CONFIRM_DELAY_S`). Its exit status is part of the contract:

| Exit | Meaning | hume (`hume.sh`) | GitHub (workflow) |
|---|---|---|---|
| 0 | completed; nothing new | stamp written, exit 0 | green run |
| 3 | completed; at least one **new** disagreement filed | stamp written, exit 0 (the board is wrong, the job is not; the issue + stamp text carry it) | `::error` + exit 1 → the one email it always sent |
| other | the check itself failed (board unreachable, `gh`/`node`/`jq` error) | stamp **withheld**, `ERROR:` line, exit N | red run |

`hume.sh` adds only what launchd lacks: the two secrets from the login keychain
(`vendor-dashboard-truth-check-pat`, `vendor-dashboard-truth-check-token` —
one credential per workload, named after the repo, read into the environment
and never logged; a missing item is exit 2 with the item named), a `mktemp`
scratch directory cleaned on exit, a 1 MiB size-capped `chmod 600` log, the
success stamp, and a host guard (the dotfiles plist is fleet-synced; any Mac
but hume declines quietly with exit 0 and no stamp).

## Fleet wiring (separate PRs, merge in this order)

1. **vendor-dashboard** (this) — scripts, workflow, tests, docs.
2. **mission-control** — `job_docs.py` page for `vendor-dashboard-truth-check`
   (the dashboard withholds its own stamp for a watched job with no page).
3. **developer-handbook** — `WATCHED_JOBS` entry (interval 60 min, grace
   45 min: a run with a confirming pass takes ~11 min) and a `DEPLOYED_CLONES`
   entry for `~/src/vendor-dashboard` on hume (the check executes from that
   clone, fast-forwarded hourly by chezmoi-sync).
4. **dotfiles** — login-items wrapper `vendor-dashboard-truth-check.sh` through
   the common run header, and the LaunchAgent
   `com.briangreenberg.vendor-dashboard-truth-check` (StartCalendarInterval
   minute 11, `PATH=/opt/homebrew/bin:/usr/bin:/bin`), linted with `plistlib`
   as well as `plutil`.

Before 3 and 4 land, the two keychain items must exist on hume; until then the
job would run, log the named error, and withhold its stamp every hour.

## Tests

`test/scripts/truth-check-sh.test.js` (vitest, stub `curl`/`gh`/`node`/`sleep`/
`security` on `PATH`, no network, no real keychain), seen red before the
scripts existed: clean pass stamps and files nothing; a new false green is
confirmed, filed, stamped, exit 3; an already-filed one is refreshed, not
re-filed; no token → compare runs, stamp skipped loudly; unreachable board →
failure, no stamp; `hume.sh` stamp on 0 and on 3, no stamp on failure or on a
missing keychain item (exit 2, named), quiet decline off-host. Both scripts pass
`shellcheck -S warning` and parse under stock `/bin/bash` 3.2.

## What this does not change

The rules (`rules.mjs`), the confirm-after-collection logic, the issue text,
the stamp shape, `validateStamp`, and the three-hour overdue rule. Two writers
of one idempotent stamp are fine; the newer wins.
