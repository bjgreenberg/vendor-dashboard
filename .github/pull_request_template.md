<!--
Conventional-Commit PR title (it becomes the squash-merge history entry), e.g.
  feat(adapter): add Atlassian via its Statuspage summary endpoint
  fix(render): escape component descriptions in the expanded list
  docs: correct the shard-rotation explanation
-->

## What changed


## Why it changed


## Testing
<!-- How you verified it: `npm test`, `npm run lint`, `npm run perf`, fixtures added. -->


---
<!-- Contributor checklist — see CONTRIBUTING.md. Tick what applies. -->
- [ ] Branch is rebased on the latest `main`; PR title is a Conventional Commit.
- [ ] Small and single-purpose (one change per PR).
- [ ] The governing rule holds: every new failure path yields `unknown`, never `operational`, and a test proves it.
- [ ] New/changed adapters are pinned against a recorded payload in `test/fixtures/` (captured from a public, unauthenticated endpoint).
- [ ] No platform APIs imported into `src/engine/` (the engine stays runtime-agnostic).
- [ ] Docs updated in **this** PR — README / diagrams / comments that describe what changed. Do **not** hand-edit `CHANGELOG.md` or version fields: release-please derives both from Conventional Commits.
- [ ] `npm test`, `npm run lint` and `npm run perf` pass locally; any Mermaid I touched renders.
- [ ] No vendor logo files committed (they are a build artifact — `scripts/fetch-logos.mjs`).
- [ ] I self-reviewed the diff (correctness, scope, security).
