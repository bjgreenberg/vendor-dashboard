# Maintainers

This project is maintained by:

- **Brian Greenberg** ([@bjgreenberg](https://github.com/bjgreenberg)) — maintainer · <https://briangreenberg.net>

## How we work

- Every change lands via a pull request with the required checks green
  (`test`, `lint`, `docs-render`, `cff-validate`, `secret-scan`) — see
  [CONTRIBUTING.md](CONTRIBUTING.md). The `perf` job runs on every PR but is
  not yet required: it is deliberately red while the collector runs against
  the Workers free plan's 10 ms CPU ceiling (the promotion trigger is
  documented in `.github/workflows/ci.yml`).
- Merges are **squash-only**. GitHub signs the squash commit, so contributions
  land **Verified** on `main` even from unsigned feature branches — no
  commit-signing setup required to contribute.
- Security reports go through **private advisories**, never public issues —
  see [SECURITY.md](SECURITY.md).

## Cutting a release

Releases are automated by [release-please](https://github.com/googleapis/release-please):
Conventional Commit types on `main` drive the version bump (`feat:` minor,
`fix:` patch, `feat!:`/`BREAKING CHANGE` major; `docs:`/`chore:` cut nothing).
release-please maintains a release PR that bumps `package.json`,
`.release-please-manifest.json`, `CHANGELOG.md` and the annotated fields in
`CITATION.cff` together; **merging that PR tags the release**. Never hand-tag,
never hand-edit the generated CHANGELOG sections.

## Container digest re-pin cadence

Three CI gates run digest-pinned containers: gitleaks (`secret-scan`),
cffconvert (`cff-validate`), and mermaid-cli (`docs-render`, pinned in
`scripts/render-diagrams.sh`). A digest keeps a gate reproducible; it does not
keep it current. **Re-pin quarterly**, or sooner when a release ships a fix
the gate needs:

1. Read the tool's release notes for behavior changes that could alter gate
   results (new gitleaks rules, Mermaid rendering changes).
2. Resolve the new tag's digest:
   `docker buildx imagetools inspect <image>:<tag>`.
3. Update the pin (workflow file or `render-diagrams.sh`), noting the tag in
   the adjacent comment.
4. Let the gate prove the bump on the PR — a digest change that alters
   behavior must fail there, not on `main`.
