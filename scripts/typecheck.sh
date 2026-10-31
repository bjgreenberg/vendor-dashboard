#!/usr/bin/env bash
# Type-check gate: mypy --strict over every .py file in the repo. The file set
# and the flags live in setup.cfg [mypy] (files = .), never on this command
# line, so a new .py file anywhere is checked the day it lands. Shared by
# local runs and CI (the `test` job runs this same script).
#
# This is a Node repo with no Python requirements file, so the type-check
# toolchain is pinned HERE, once: mypy, and Pillow because
# scripts/make-social-card.py imports it and mypy checks the script against
# Pillow's inline types. Both go in .venv (git-ignored, excluded from the
# check), created on first run; an installed exact pin is a no-op re-install.
#
# It also asserts the count: the number of files mypy reports checking must
# equal the number of .py files git sees (tracked plus untracked, minus
# .gitignore'd ones such as the venvs). mypy's directory walk skips
# dot-directories such as .github/, so without this a .py file there would pass
# unchecked.
set -euo pipefail
cd "$(dirname "$0")/.."
MYPY_PIN="mypy==2.4.1"
PILLOW_PIN="pillow==13.0.0"
if [[ ! -x .venv/bin/python ]]; then "${PYTHON:-python3}" -m venv .venv; fi
.venv/bin/python -m pip install --quiet --disable-pip-version-check "$MYPY_PIN" "$PILLOW_PIN"
.venv/bin/mypy --version

expected=$(git ls-files --cached --others --exclude-standard -- '*.py' | wc -l | tr -d ' ')
if [[ "$expected" -eq 0 ]]; then
  echo "typecheck: git sees no .py files; refusing to pass on an empty set" >&2
  exit 1
fi

rc=0
out=$(.venv/bin/mypy 2>&1) || rc=$?
printf '%s\n' "$out"
if [[ "$rc" -ne 0 ]]; then
  exit "$rc"
fi

checked=$(printf '%s\n' "$out" | sed -nE 's/^Success: no issues found in ([0-9]+) source files?$/\1/p')
if [[ "$checked" != "$expected" ]]; then
  echo "typecheck: mypy checked ${checked:-an unknown number of} files but git sees $expected .py files" >&2
  exit 1
fi
echo "typecheck: $checked of $expected .py files checked"
