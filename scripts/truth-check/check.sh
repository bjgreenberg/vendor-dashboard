#!/bin/bash
# check.sh — the truth check, as ONE script both runners execute.
#
# The GitHub workflow (.github/workflows/truth-check.yml, every two hours —
# the external backstop) and hume's hourly launchd job (scripts/truth-check/
# hume.sh — the primary since 2026-09-25, because GitHub's cron dropped slots
# and the board read "Truth check overdue" on a scheduling miss) run these
# exact steps, so the two can never drift apart:
#
#   1. fetch the board's /api/status and compare it with each covered
#      vendor's own feed (run.mjs — a code path that shares nothing with the
#      adapters; see rules.mjs);
#   2. a false green (board operational, vendor says otherwise) is rechecked
#      after the board's next collection before anything is filed;
#   3. file / refresh one GitHub issue per confirmed false green, comment
#      and close the ones that agree again;
#   4. stamp the board (POST /api/truth-check) so verification is visible —
#      a stale stamp is itself the alarm (render.js: overdue after 3 h).
#
# Environment (the contract):
#   ORIGIN                       the board, e.g. https://…workers.dev/service-status
#   GITHUB_REPOSITORY            owner/repo whose issues carry the findings
#   GH_TOKEN                     what `gh` authenticates with (issues: write)
#   TRUTH_CHECK_TOKEN            optional; without it the stamp step is skipped
#   WATCHDOG_WEBHOOK_URL         optional Slack-compatible mirror for NEW findings
#   TRUTH_CHECK_CONFIRM_DELAY_S  seconds before the confirming pass (default 600)
#   TRUTH_CHECK_REPO_DIR         the checkout (default: this script's repo)
# Runs in the CURRENT directory, which the caller makes scratch; every file it
# writes (status.json, report*.json, body.md, summary.txt, …) lands there.
#
# Exit status — the runners key on it, so it is part of the contract:
#   0  the check completed; nothing new (clean, or known findings refreshed)
#   3  the check completed and filed at least one NEW disagreement
#   *  anything else is a failure of the check itself (board unreachable,
#      gh/jq/node error) — no stamp was, or should be, written
#
# Dependencies: bash 3.2+, curl, jq, node ≥ 22, gh (authenticated via GH_TOKEN).
set -euo pipefail

: "${ORIGIN:?ORIGIN is required: the board origin, .../service-status}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"
: "${GH_TOKEN:?GH_TOKEN is required (gh authenticates with it)}"
CONFIRM_DELAY="${TRUTH_CHECK_CONFIRM_DELAY_S:-600}"
REPO_DIR="${TRUTH_CHECK_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
readonly EXIT_NEW_DISAGREEMENT=3

for tool in curl jq node gh; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is not on PATH — the truth check cannot run" >&2; exit 2; }
done

# ── 0. the label the findings carry ──────────────────────────────────────────
gh label create truth-check --repo "$GITHUB_REPOSITORY" \
  --description "The board and the vendor disagree" --color B60205 --force >/dev/null

# ── 1. compare the board with the vendors' own feeds ─────────────────────────
curl -sf --max-time 30 "$ORIGIN/api/status" -o status.json
node "$REPO_DIR/scripts/truth-check/run.mjs" status.json "$REPO_DIR/config/vendors.json" --out report.json | tee summary.txt

# ── 2. confirm any false green after the board's next collection ─────────────
if [ "$(jq '.falseGreen | length' report.json)" = "0" ]; then
  echo "no false green on the first pass — nothing to confirm"
else
  echo "first pass: $(jq -r '[.falseGreen[].vendor] | join(", ")' report.json) — rechecking in ${CONFIRM_DELAY}s"
  sleep "$CONFIRM_DELAY"
  curl -sf --max-time 30 "$ORIGIN/api/status" -o status.json
  node "$REPO_DIR/scripts/truth-check/run.mjs" status.json "$REPO_DIR/config/vendors.json" --out report2.json | tee summary.txt
  jq --slurpfile first report.json '
    ($first[0].falseGreen | map(.vendor)) as $keep
    | .falseGreen |= [ .[] | select(.vendor as $v | ($keep | index($v)) != null) ]
  ' report2.json > report.confirmed.json
  mv report.confirmed.json report.json
  echo "confirmed: $(jq -r '[.falseGreen[].vendor] | join(", ") | if . == "" then "none" else . end' report.json)"
fi

# ── 3. file or refresh an issue per false green; close the agreed ones ───────
: > newly-filed.txt
jq -c '.falseGreen[]' report.json | while IFS= read -r fg; do
  vendor=$(jq -r '.vendor' <<<"$fg")
  {
    echo "The board renders **$vendor** as \`$(jq -r '.rendered' <<<"$fg")\` while the vendor's own feed says otherwise (truth-check $(jq -r '.checkedAt' report.json))."
    echo
    echo "Vendor evidence, read by the second-opinion rule (not the adapter):"
    echo
    jq -r '.evidence[] | "- " + .' <<<"$fg"
    echo
    jq -r '.urls[] | "- source: " + .' <<<"$fg"
    echo
    echo "What the board rendered:"
    echo
    echo '```json'
    jq --arg v "$vendor" '.records[] | select(.vendor == $v) | {severity, incidentName, description, checkedAt}' status.json
    echo '```'
    echo
    echo "_Filed automatically by the truth check. It will comment and close this issue when the board and the vendor agree again._"
  } > body.md
  number=$(gh issue list --repo "$GITHUB_REPOSITORY" --label truth-check --state open \
             --search "\"truth-check: $vendor\" in:title" --json number --jq '.[0].number // empty')
  if [ -n "$number" ]; then
    gh issue comment "$number" --repo "$GITHUB_REPOSITORY" --body-file body.md >/dev/null
    echo "refreshed #$number for $vendor"
  else
    url=$(gh issue create --repo "$GITHUB_REPOSITORY" --label truth-check \
            --title "truth-check: $vendor" --body-file body.md)
    echo "filed $url"
    echo "$vendor" >> newly-filed.txt
    if [ -n "${WATCHDOG_WEBHOOK_URL:-}" ]; then
      jq -n --arg v "$vendor" --arg u "$url" \
        '{text: "vendor-dashboard truth-check: the board says \($v) is operational; the vendor disagrees — \($u)"}' |
        curl -sf --max-time 15 -X POST -H 'Content-type: application/json' --data @- "$WATCHDOG_WEBHOOK_URL" >/dev/null \
        || echo "webhook post failed (non-fatal)"
    fi
  fi
done
gh issue list --repo "$GITHUB_REPOSITORY" --label truth-check --state open \
  --json number,title --jq '.[] | "\(.number)\t\(.title)"' |
while IFS=$'\t' read -r number title; do
  [ -n "$number" ] || continue
  vendor=${title#truth-check: }
  if ! jq -e --arg v "$vendor" '.falseGreen[] | select(.vendor == $v)' report.json >/dev/null; then
    gh issue comment "$number" --repo "$GITHUB_REPOSITORY" \
      --body "Agreed again at $(jq -r '.checkedAt' report.json): the board and $vendor's own feed now say the same thing. Closing."
    gh issue close "$number" --repo "$GITHUB_REPOSITORY"
  fi
done
new=$(wc -l < newly-filed.txt | tr -d ' ')

# ── 4. stamp the board ───────────────────────────────────────────────────────
if [ -z "${TRUTH_CHECK_TOKEN:-}" ]; then
  echo "TRUTH_CHECK_TOKEN not configured — the board keeps reading 'Not yet truth-checked'"
else
  jq '{checkedAt, covered, total, agreed, disagreements: (.falseGreen | length), falseGreen: [.falseGreen[].vendor]}' report.json > stamp.json
  code=$(curl -s --max-time 30 -o stamp-response.txt -w '%{http_code}' -X POST \
           -H "Authorization: Bearer $TRUTH_CHECK_TOKEN" -H 'Content-Type: application/json' \
           --data @stamp.json "$ORIGIN/api/truth-check")
  echo "stamp HTTP $code"; cat stamp-response.txt; echo
  [ "$code" = "204" ]
fi

# ── 5. one loud line per NEW false green; the exit status carries it ─────────
if [ "$new" != "0" ]; then
  echo "$new new disagreement(s) filed — see the truth-check issues"
  cat summary.txt
  exit "$EXIT_NEW_DISAGREEMENT"
fi
exit 0
