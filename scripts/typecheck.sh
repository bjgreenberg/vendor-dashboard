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
set -euo pipefail
cd "$(dirname "$0")/.."
MYPY_PIN="mypy==2.4.1"
PILLOW_PIN="pillow==13.0.0"
if [[ ! -x .venv/bin/python ]]; then "${PYTHON:-python3}" -m venv .venv; fi
.venv/bin/python -m pip install --quiet --disable-pip-version-check "$MYPY_PIN" "$PILLOW_PIN"
.venv/bin/mypy --version
.venv/bin/mypy
