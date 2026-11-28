#!/usr/bin/env python3
"""One parser for every CHANGELOG.md the fleet keeps (worklist #214).

`parse(text)` turns a Keep a Changelog file into releases, newest first, and
lists every `## ` heading it could not read as a problem with its line number.
The standard rewrites no repo's history, so every heading shape in use today is
read (scan of 2026-10-24: 824 releases in 27 repos):

| Shape | Example |
|---|---|
| release-please | `## [1.9.0](…/compare/v1.8.0...v1.9.0) (2026-10-12)`, `## 1.0.0 (2026-09-01)` |
| version and date | `## [1.0.0] - 2026-07-04`, `## v2.0.0-rc.1 (2026-07-04)` |
| date, optional summary | `## 2026-10-15 (summary)`, `## 2026-03-23 — summary`, `## [2026-07-05] — summary` |
| dotted date | `## 2026.10.12` |
| date, summary, version | `## 2026-08-24 (summary) — 0.8.1` |
| unreleased | `## [Unreleased]`, `## Unreleased` |

Each release keeps its heading exactly as written (mission-control links its
GitHub anchor), a version or null, an ISO date or null, whether it is
unreleased, the summary, and its `### ` sections by their own names (Added,
Fixed, or release-please's Features, Bug Fixes …) with each item's raw
markdown. A heading inside a code fence is text, not a release. A file with no
release heading, or none at all, is a problem, never an empty success.

The repo a file belongs to is the caller's to know (mission-control takes it
from repo-steward's census); this module only reads text. Standard library
only, so mission-control loads it by path the way it loads health_monitor.py.

CLI: `changelog.py [--json] FILE...` prints the parse as JSON (with `--json`)
and exits 1 when any file has a problem, naming each on stderr.

The PR check (step 2, docs/adr/0005): `changelog.py --check BASE HEAD` run in a
repo's checkout fails when its `CHANGELOG.md` is missing at HEAD, has a heading
`parse` cannot read, or when code changed in BASE...HEAD with no change to
`CHANGELOG.md`. Docs, Markdown, `.github/` and `LICENSE` are not code. A repo
whose changelog release-please writes (`release-please-config.json` at HEAD),
a Dependabot or Renovate PR, and a release-please branch need no line; their
changelog is still parsed. `--report` prints the findings as warnings and
exits 0: the first rung of the monitor → block ladder.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess  # nosec B404 - fixed git argv, no shell
import sys
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import TypedDict

_DATE = r"(\d{4})[-.](\d{2})[-.](\d{2})"
_VERSION = r"v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)"
_DASH = r"[—–-]"
# A heading led by a version: release-please's linked form, Keep a Changelog's
# `[1.0.0] - date`, or a bare `1.0.0 (date)`, with an optional trailing summary.
_VERSION_HEADING = re.compile(
    rf"^\[?{_VERSION}\]?(?:\([^)]*\))?"
    rf"(?:\s*(?:\(|{_DASH})\s*\[?{_DATE}\]?\)?)?"
    rf"(?:\s+{_DASH}\s+(?P<summary>.+?))?\s*$"
)
# A heading led by a date, then `(summary)`, `— summary`, or nothing, and maybe a trailing `— 0.8.1`.
_DATE_HEADING = re.compile(rf"^\[?{_DATE}\]?(?P<rest>\s+.*)?$")
_TRAILING_VERSION = re.compile(rf"\s+{_DASH}\s+{_VERSION}\s*$")
_UNRELEASED = re.compile(r"^\[?unreleased\]?(?:\s*(?:\(|[—–-]).*)?\s*$", re.IGNORECASE)
_FENCE = re.compile(r"^\s*(```|~~~)")
_ITEM = re.compile(r"^[-*+]\s+(.*)$")

CHANGELOG = "CHANGELOG.md"
# Not code: a change to these alone needs no changelog line.
_NOT_CODE = re.compile(r"(?:^|/)[^/]+\.md$|^docs/|^\.github/|^LICENSE(?:\.\w+)?$")
_BOT_AUTHORS = frozenset({"dependabot[bot]", "renovate[bot]"})
_BOT_BRANCH_PREFIXES = ("release-please--", "dependabot/", "renovate/")
_RELEASE_PLEASE_FILES = ("release-please-config.json", ".release-please-manifest.json")
# Every git call here reads a local checkout. One that runs this long has hung; the check says so.
GIT_TIMEOUT_S = 60


class Release(TypedDict):
    """One `## ` release of a changelog."""

    heading: str
    line: int
    version: str | None
    date: str | None
    unreleased: bool
    summary: str | None
    sections: dict[str, list[str]]


class Problem(TypedDict):
    """A line that is not what the standard allows; line 0 is the file itself."""

    line: int
    message: str


class Parsed(TypedDict):
    releases: list[Release]
    problems: list[Problem]


def _iso(year: str, month: str, day: str) -> str | None:
    """The ISO date, or None when it is not a real day."""
    try:
        return date(int(year), int(month), int(day)).isoformat()
    except ValueError:
        return None


def _summary(rest: str) -> tuple[str | None, str | None]:
    """A date heading's tail: its summary and a trailing version, either or both absent."""
    version = None
    found = _TRAILING_VERSION.search(rest)
    if found:
        version, rest = found.group(1), rest[: found.start()]
    rest = rest.strip()
    if rest.startswith("(") and rest.endswith(")"):
        rest = rest[1:-1].strip()
    elif rest[:1] in "—–-":
        rest = rest[1:].strip()
    return (rest or None), version


def _release(heading: str, number: int) -> tuple[Release | None, str | None]:
    """The release a heading names, or the reason it names none."""
    base = Release(
        heading=heading, line=number, version=None, date=None, unreleased=False, summary=None, sections={}
    )
    if _UNRELEASED.match(heading):
        base["unreleased"] = True
        return base, None
    # A date first: `2026.10.12` also reads as a version.
    found = _DATE_HEADING.match(heading)
    if found:
        base["date"] = _iso(found.group(1), found.group(2), found.group(3))
        if base["date"] is None:
            return None, "not a real date"
        base["summary"], base["version"] = _summary(found.group("rest") or "")
        return base, None
    found = _VERSION_HEADING.match(heading)
    if found:
        base["version"] = found.group(1)
        if found.group(2):
            base["date"] = _iso(found.group(2), found.group(3), found.group(4))
            if base["date"] is None:
                return None, "not a real date"
        base["summary"] = found.group("summary")
        return base, None
    return None, "not a release heading"


def parse(text: str) -> Parsed:
    """Every release of a changelog, newest first as written, and every problem."""
    releases: list[Release] = []
    problems: list[Problem] = []
    current: Release | None = None
    section: str | None = None
    in_fence = False
    open_item = False  # the last item may still take continuation lines (no blank line since)
    for number, line in enumerate(text.splitlines(), 1):
        fence_line = bool(_FENCE.match(line))
        if fence_line:
            in_fence = not in_fence
        if in_fence or fence_line:
            # A heading in a fence is text. The fence belongs to the item it continues,
            # or is an item of its own after a blank line.
            if current is not None:
                if section is None:
                    section = ""
                    current["sections"].setdefault(section, [])
                items = current["sections"][section]
                if open_item and items:
                    items[-1] += "\n" + line
                else:
                    items.append(line)
                    open_item = True
            continue
        if line.startswith("## "):
            heading = line[3:].strip()
            current, why = _release(heading, number)
            section = None
            open_item = False
            if current is None:
                problems.append(Problem(line=number, message=f"{why}: {line.rstrip()}"))
            else:
                releases.append(current)
            continue
        if current is None:
            continue
        if line.startswith("### "):
            section = line[4:].strip()
            current["sections"].setdefault(section, [])
            open_item = False
            continue
        if not line.strip():
            open_item = False
            continue
        if section is None:
            section = ""
            current["sections"].setdefault(section, [])
        item = _ITEM.match(line)
        items = current["sections"][section]
        if item:
            items.append(item.group(1).rstrip())
        elif open_item and items:
            items[-1] += "\n" + line.strip()
        else:
            items.append(line.strip())
        open_item = True
    if not releases and not problems:
        problems.append(Problem(line=0, message="no release headings"))
    return Parsed(releases=releases, problems=problems)


def parse_file(path: Path) -> Parsed:
    """`parse` of a file; a file that is missing or unreadable is a problem."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return Parsed(releases=[], problems=[Problem(line=0, message="no CHANGELOG.md")])
    except (OSError, UnicodeDecodeError) as exc:
        return Parsed(releases=[], problems=[Problem(line=0, message=f"unreadable: {type(exc).__name__}")])
    return parse(text)


def check(
    changed: Sequence[str],
    changelog_text: str | None,
    *,
    release_please: bool = False,
    author: str = "",
    branch: str = "",
) -> list[str]:
    """Why a change fails the changelog standard, or [] when it passes.

    `changed` are the paths the change touches; `changelog_text` is
    CHANGELOG.md at the change's head, or None when there is none."""
    if changelog_text is None:
        return [f"no {CHANGELOG}"]
    findings = [f"{CHANGELOG}:{p['line']}: {p['message']}" for p in parse(changelog_text)["problems"]]
    if release_please or author in _BOT_AUTHORS or branch.startswith(_BOT_BRANCH_PREFIXES):
        return findings
    code = [path for path in changed if not _NOT_CODE.search(path)]
    if code and CHANGELOG not in changed:
        findings.append(f"code changed ({len(code)} files, e.g. {code[0]}) with no line in {CHANGELOG}")
    return findings


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git is not installed")
    try:
        return subprocess.run(  # nosec B603 - fixed argv
            [git, *args], capture_output=True, text=True, check=False, timeout=GIT_TIMEOUT_S
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"git {args[0]} timed out after {GIT_TIMEOUT_S} s") from exc


def _check_range(base: str, head: str, author: str, branch: str) -> list[str]:
    """`check` over a git range in the current checkout."""
    diff = _git("diff", "--name-only", f"{base}...{head}")
    if diff.returncode != 0:
        return [f"cannot diff {base}...{head}: {diff.stderr.strip()}"]
    shown = _git("show", f"{head}:{CHANGELOG}")
    text = shown.stdout if shown.returncode == 0 else None
    release_please = any(_git("cat-file", "-e", f"{head}:{name}").returncode == 0 for name in _RELEASE_PLEASE_FILES)
    changed = [line for line in diff.stdout.splitlines() if line]
    return check(changed, text, release_please=release_please, author=author, branch=branch)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Parse CHANGELOG.md files to the fleet's standard (worklist #214).")
    parser.add_argument("--json", action="store_true", help="print every parse as JSON on stdout")
    parser.add_argument("--check", nargs=2, metavar=("BASE", "HEAD"), help="check a change in this checkout")
    parser.add_argument("--author", default="", help="with --check: the PR's author login")
    parser.add_argument("--branch", default="", help="with --check: the PR's head branch")
    parser.add_argument("--report", action="store_true", help="with --check: warn, never fail")
    parser.add_argument("files", nargs="*", type=Path)
    args = parser.parse_args(argv)
    if args.check:
        try:
            findings = _check_range(args.check[0], args.check[1], args.author, args.branch)
        except RuntimeError as exc:  # no git, or a git that hung: the change was not checked
            findings = [str(exc)]
        for finding in findings:
            print(f"::{'warning' if args.report else 'error'}::{finding}")
        if not findings:
            print("PASS: the changelog standard holds for this change.")
        return 1 if findings and not args.report else 0
    if not args.files:
        parser.error("name a CHANGELOG.md, or use --check BASE HEAD")
    results = {str(path): parse_file(path) for path in args.files}
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    failed = False
    for name, parsed in results.items():
        for problem in parsed["problems"]:
            failed = True
            print(f"{name}:{problem['line']}: {problem['message']}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
