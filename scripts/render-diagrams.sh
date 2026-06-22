#!/usr/bin/env bash
#
# render-diagrams.sh — render-check every ```mermaid block in the repo's Markdown.
#
# A single Mermaid syntax slip degrades the WHOLE fenced block to a red "Unable to
# render" box for every reader (GitHub, VS Code), so an unrenderable diagram is a
# broken deliverable — like a failing test. This script renders EVERY block and
# exits non-zero if any failed (it reports all failures, not just the first).
#
# It uses the official, DIGEST-PINNED mermaid-cli container (its own bundled
# Chromium) — no Node, npm, or Chrome on the host or the CI runner. Dependencies:
# a Docker runtime (locally OrbStack) plus python3 and standard Unix tools
# (find/grep/sed) — all present on macOS and the ubuntu-latest runner.
#
# Usage:  scripts/render-diagrams.sh
# CI:     the `docs-render` job runs exactly this.
#
set -euo pipefail

# Pinned by digest (tag 11.4.2). Bump deliberately and re-pin the digest; this is
# not in an ecosystem Dependabot tracks. Both ghcr.io/mermaid-js and Docker Hub
# minlag/mermaid-cli publish this identical digest.
IMG="ghcr.io/mermaid-js/mermaid-cli/mermaid-cli@sha256:99c983b3ab4e14033f2880bc1b9de17e5090b4515dabd63fe9cf8c0ae6130956"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# Collect Markdown files, skipping vendored / VCS directories.
mapfile -t md_files < <(find . -type f -name '*.md' \
  -not -path './node_modules/*' -not -path './.git/*' | sort)

# Extract every fenced mermaid block to <path-slug>__<n>.mmd. The path is part of
# the name so the three README.md files (db/ api/ worker/) can't collide.
manifest="$workdir/manifest.txt"
python3 - "$workdir" "$manifest" "${md_files[@]}" <<'PY'
import re, sys, pathlib

workdir, manifest = sys.argv[1], sys.argv[2]
files = sys.argv[3:]
rows = []
for f in files:
    text = pathlib.Path(f).read_text()
    for i, block in enumerate(re.findall(r"```mermaid\n(.*?)```", text, re.S), 1):
        slug = f.removeprefix("./").replace("/", "__").removesuffix(".md")
        name = f"{slug}__{i}.mmd"
        pathlib.Path(workdir, name).write_text(block)
        rows.append(f"{name}\t{f}#block{i}")
pathlib.Path(manifest).write_text("".join(r + "\n" for r in rows))
print(f"Found {len(rows)} mermaid block(s) across {len(files)} Markdown file(s).")
PY

block_count="$(grep -c . "$manifest" 2>/dev/null || echo 0)"
if [[ "${block_count}" -eq 0 ]]; then
  echo "No mermaid blocks found — nothing to render."
  exit 0
fi

# Pull the renderer once (quiet), then render each block.
docker pull -q "$IMG" >/dev/null

fail=0
while IFS=$'\t' read -r name origin; do
  [[ -z "${name}" ]] && continue
  out="${name%.mmd}.svg"
  if docker run --rm -u "$(id -u):$(id -g)" -v "$workdir:/data" "$IMG" \
        -i "/data/${name}" -o "/data/${out}" >/dev/null 2>"$workdir/err.log" \
     && [[ -s "$workdir/${out}" ]]; then
    echo "  OK     ${origin}"
  else
    echo "  BROKEN ${origin}"
    sed 's/^/           /' "$workdir/err.log" 2>/dev/null || true
    fail=1
  fi
done < "$manifest"

if [[ "${fail}" -ne 0 ]]; then
  echo "FAIL: at least one Mermaid diagram failed to render."
  exit 1
fi
echo "PASS: all ${block_count} Mermaid diagram(s) rendered."
