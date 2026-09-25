#!/bin/bash
# hume.sh — the hourly launchd runner for the truth check on the always-on Mac.
#
# Since 2026-09-25 hume is the PRIMARY runner (com.briangreenberg.vendor-
# dashboard-truth-check, hourly at :11; the dotfiles LaunchAgent execs this
# through the login-items wrapper and the common run header) and the GitHub
# workflow is the external backstop. Both execute scripts/truth-check/check.sh;
# this file only supplies what launchd does not: the secrets, a scratch
# directory, a capped log, and the success stamp health-monitor watches.
#
# Secrets come from the login keychain, one item per credential, named after
# this repo (never a shared key, never a token in this file or the plist):
#   vendor-dashboard-truth-check-pat    fine-grained GitHub PAT, this repo only,
#                                       Issues: read/write (+ Metadata: read)
#   vendor-dashboard-truth-check-token  the Worker's TRUTH_CHECK_TOKEN secret
# A missing item is a NAMED failure (exit 2, no stamp): the log says which
# item to add. The values reach check.sh as environment only and are never
# written to the log.
#
# Stamp semantics: ~/.local/state/vendor-dashboard-truth-check/last-success is
# touched when the CHECK COMPLETED — exit 0 (clean / known findings) or exit 3
# (a new disagreement was filed: the board is wrong, the job is not). Any other
# exit is the job failing (board unreachable, gh/node/jq error): the stamp is
# withheld and health-monitor's dead man's switch says so. A new disagreement
# is loud in its own right (a GitHub issue, and the board's stamp text).
#
# Only the always-on host runs it. The dotfiles plist is fleet-synced, so on
# any other Mac this declines quietly (exit 0, no stamp — that host is not in
# health-monitor's WATCHED_JOBS for this job).
#
# Seams (tests only; never set in production): TRUTH_CHECK_SECURITY_BIN,
# TRUTH_CHECK_HOST, TRUTH_CHECK_REPO_DIR, TRUTH_CHECK_CONFIRM_DELAY_S.
# Dependencies: bash 3.2+ (stock /bin/bash), curl, jq, node ≥ 22, gh — the
# plist puts /opt/homebrew/bin on PATH; launchd's default PATH lacks it.
set -uo pipefail

LOG="$HOME/Library/Logs/vendor-dashboard-truth-check.log"
LOG_MAX_BYTES=$((1024 * 1024))  # house rule: size-capped, not line-capped
STAMP="$HOME/.local/state/vendor-dashboard-truth-check/last-success"
SECURITY="${TRUTH_CHECK_SECURITY_BIN:-/usr/bin/security}"
HOST="${TRUTH_CHECK_HOST:-$(/bin/hostname -s)}"
REPO_DIR="${TRUTH_CHECK_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ORIGIN="${ORIGIN:-https://vendor-dashboard.gsysd.workers.dev/service-status}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-bjgreenberg/vendor-dashboard}"

mkdir -p "$(dirname "$LOG")"
# Cap the log BEFORE appending (rotate-then-append; nothing holds it open).
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt "$LOG_MAX_BYTES" ]; then
  tail -c "$LOG_MAX_BYTES" "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
touch "$LOG"; chmod 600 "$LOG"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"; }

if [ "$HOST" != "hume" ]; then
  log "not the always-on host ($HOST) — declining; the truth check runs on hume"
  exit 0
fi

# ── secrets: keychain → environment, never the log ───────────────────────────
read_secret() {
  # $1 = keychain service name. Exit-code verdict only; the value is captured
  # by the caller into a variable and handed to check.sh as environment.
  "$SECURITY" find-generic-password -s "$1" -w 2>/dev/null
}
if ! PAT=$(read_secret vendor-dashboard-truth-check-pat) || [ -z "$PAT" ]; then
  log "ERROR: keychain item vendor-dashboard-truth-check-pat missing or unreadable — add the fine-grained PAT (this repo, Issues: read/write) under that service name in the login keychain"
  exit 2
fi
if ! TOKEN=$(read_secret vendor-dashboard-truth-check-token) || [ -z "$TOKEN" ]; then
  log "ERROR: keychain item vendor-dashboard-truth-check-token missing or unreadable — add the Worker's TRUTH_CHECK_TOKEN under that service name in the login keychain"
  exit 2
fi

# ── scratch dir, always cleaned ──────────────────────────────────────────────
WORK=$(mktemp -d "${TMPDIR:-/tmp}/vendor-dashboard-truth-check.XXXXXX") || { log "ERROR: mktemp failed"; exit 2; }
trap 'rm -rf "$WORK"' EXIT

log "truth check starting (repo $REPO_DIR, board $ORIGIN)"
(
  cd "$WORK" && \
  ORIGIN="$ORIGIN" GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GH_TOKEN="$PAT" TRUTH_CHECK_TOKEN="$TOKEN" \
  TRUTH_CHECK_REPO_DIR="$REPO_DIR" \
  bash "$REPO_DIR/scripts/truth-check/check.sh"
) >> "$LOG" 2>&1
rc=$?

case "$rc" in
  0|3)
    mkdir -p "$(dirname "$STAMP")" && touch "$STAMP"
    if [ "$rc" = 3 ]; then
      log "truth check completed: NEW disagreement(s) filed as issues — stamp written (the board is wrong, the job is not)"
    else
      log "truth check completed clean — stamp written"
    fi
    exit 0
    ;;
  *)
    log "ERROR: truth check failed (exit $rc) — stamp withheld; see the lines above"
    exit "$rc"
    ;;
esac
