# AUDIT: bjgreenberg/vendor-dashboard @ 7516265

**Extraction audit** — scoped to *what carries forward into the Cloudflare Worker port*, not to repairing the Apps Script in place.

Date: 2026-07-30 · Auditor: Claude (senior-engineering-partner `AUDIT:` mode) · Host: local development Mac

---

## Verdict

The **repository infrastructure is genuinely strong** and the **orchestrator's failure isolation is well designed**; the **adapters are the valuable asset and mostly worth porting**. But the tool has **five defects that cause it to report healthy when it is not** — and I measured two of them producing wrong answers on live vendor data during this audit. For a monitoring tool, false green is the worst failure mode, and this codebase has several independent sources of it. Nothing here is a security emergency; the severity scale below is **functional correctness**, since there is no untrusted-input, multi-tenant, or credential surface.

---

## What I mechanically verified (not eyeballed)

| Check | Command / method | Result |
|---|---|---|
| `const` reassignment is fatal | `node -e 'const r=[1]; r=r.filter(Boolean)'` | `TypeError: Assignment to constant variable.` — **confirmed throws** |
| `FILTERS` is wired up | `grep -n allowedComponents Code.js` | **1 hit — the function signature only.** Never read in the body |
| `fetchTableauStatus_` is called | `grep -n 'fetchTableauStatus_'` | Definition + its own log line. **No call site** — dead |
| Component status is read | `grep -n '\.components'` | Only existence tests (`if (!data.components) return []`). **Status never read** |
| Secrets ever committed | `git log --all -- .clasp.json AGENTS.md creds.json` | **Empty — never committed.** Clean |
| Files ever in history | `git log --diff-filter=A --name-only` | 19 files, no credential artifacts |
| Test suite exists | `find . -name '*test*' -o -name '*spec*'` | **NONE** |
| Status vocabulary | `grep -oE '"(Operational\|Degraded\|Down)"'` | 20 / 18 / **1** — `Down` emitted once, by Concur only |
| Live vendor behaviour | Fetched **25** Statuspage feeds, replayed `fetchStatuspageSummary_` logic against real payloads | **2 of 25 diverge from the vendor's own verdict — in opposite directions** |
| Repo visibility | `gh repo view --json isPrivate` | `true` (private, Apache-2.0) |

---

## Findings — severity ranked

### HIGH

**H1 — The Microsoft adapter is hardcoded to "Operational" and can never report an outage.**
`Code.js:326-329`. The function fetches the endpoint into `const data`, then **discards it entirely** and returns a literal `"Operational" / "Everything is up and running."` row.

```js
function fetchMicrosoftStatus_(vendor, url, nowIso) {
  const data = fetchJson_(url);            // <-- fetched
  return [[vendor, "Microsoft 365", "Operational", ...]];  // <-- and ignored
}
```

**Impact:** Microsoft 365 — one of the two largest dependencies in the fleet — is monitored **in name only**. It has displayed green 100% of the time since the tool was written, including through any real M365 incident. Anyone reading the dashboard has been given a guarantee the tool never checked. It also burns a subrequest per run to fetch data it throws away.
**Fix:** Implement the adapter against the real payload shape, or **remove the row entirely**. A missing row is honest; a permanently-green row is not. Do not port this as-is.

**H2 — The malformed-row guard crashes the entire run instead of preventing a crash.**
`Code.js:59` declares `const rows = []`; `Code.js:136` executes `rows = rows.filter(...)`. Assignment to a `const` binding is a runtime `TypeError` (proven above). The line sits inside `if (badRows.length > 0)` and is **not** wrapped in a `try/catch`.

**Impact:** Exactly when an adapter returns a malformed row — the situation this code exists to survive — `refreshVendorStatus()` throws before reaching the write at line 142. **Nothing is written, and the sheet retains stale data with no visible error.** The comment above it reads *"Filter them out to prevent crash, allowing remaining good rows to write"* — the precise opposite of the behaviour. This is a latent time bomb: it only fires when a vendor changes its payload shape, which is also when you most need the dashboard.
**Fix:** `let rows = []`, or filter into a new binding. In the port, make schema validation a typed boundary that drops the bad row and emits a structured warning.

**H3 — `FILTERS` is dead config: the tool cannot scope a vendor to the services you care about.**
`Code.js:45-49` defines `FILTERS` for OpenAI, Cloudflare, and Zoom. `Code.js:241` accepts `allowedComponents`. **The parameter is never referenced in the function body** (verified: one grep hit, the signature). The config silently does nothing.

**Impact — measured live during this audit, in both directions:**

| Vendor | Vendor's own indicator | Tool reports | Why |
|---|---|---|---|
| **Cloudflare** | `minor` | **Operational** | 26 `partial_outage` + 20 `under_maintenance` among **470** components — Arica Chile, Baghdad, Guam. Under-reports |
| **KnowBe4** | `none` | **Degraded** | Open incident is *"Protect blank purchasing page on store.knowbe4.com"* — a marketing storefront. Over-reports |

KnowBe4 is the red row in your screenshot. Both errors have the **same root cause**: no way to express *"I care about Cloudflare Workers, not the Guam PoP"* or *"I care about KnowBe4 training, not their online store."* Without component scoping the signal/noise problem is **undecidable** — which is why naive component roll-up is not the fix either (it would turn Cloudflare permanently red).
**Fix:** Implement the allowlist. In the port make it first-class per-vendor config: `components: ["Workers","Dashboard"]`, defaulting to the page-level `status.indicator` when unspecified. **This is the single highest-value change in the audit** and it feeds directly into the severity-sort requirement.

**H4 — Error handling fails OPEN: a network failure is reported as "Operational".**
`Code.js:507` (Concur) and `Code.js:735` (StatusGator) both `catch` and return a healthy row with description *"Status check unavailable (Network Error)."* — but the **status column says `Operational`**.

**Impact:** A vendor whose status page is unreachable — plausibly *because* they are having an outage — renders green. The explanatory text is in a column nobody sorts or filters on, and your dashboard's colour coding keys on status. This directly contradicts the house rule *fail closed: never swallow an error and return a default that reads as success.* Note the inconsistency: `fetchStormboardStatus_:217-220` gets this **right**, returning `Degraded` + `"Status check failed."`
**Fix:** Introduce a distinct `Unknown` / `Check failed` state that is visually distinct from both healthy and down, and never collapses to green. Port Stormboard's convention, not Concur's.

**H5 — Zero automated tests, and the platform makes them impossible.**
`find` returns no test files; `package.json` `test` is a deliberate no-op; CI gates on `node --check` only. This is *documented as intentional* in `CLAUDE.md:29-31` and is a correct read of Apps Script's constraints — Apps Script logic cannot be unit-tested off-platform.

**Impact:** Every finding above would have been caught by one fixture-based test. H1 (Microsoft) and H2 (`const`) are each a single assertion. For a repo you intend to **open-source**, "no tests by design" is a hard sell to any prospective adopter.
**Fix:** This resolves itself in the port — a Worker is plain JS on workerd. Record each vendor payload fetched during this audit as a **golden fixture** and pin every adapter's output. That corpus is also what would let a future reimplementation on another platform be proven equivalent.

### MEDIUM

**M1 — Binary status vocabulary discards the severity gradations the sort requires.**
`Code.js:344-347` collapses everything to `Operational` | `Degraded`. Concur alone emits a third value, `"Down"` (`Code.js:482`), which no other adapter produces and `normalizeStatus_` never generates — so the sheet carries an inconsistent three-value vocabulary that nothing normalizes.

**Impact:** Statuspage supplies `major_outage` / `partial_outage` / `degraded_performance` / `under_maintenance` for free and the tool throws them away. **This directly blocks the requested "sort by down-first" behaviour** — you cannot rank severity you did not retain. It is also why your screenshot shows a total outage and a minor blip in identical red.
**Fix:** Preserve the vendor's native severity, normalize to an ordered enum (`major_outage > partial_outage > degraded > maintenance > operational > unknown`), and sort on its ordinal.

**M2 — Component-level outages are invisible; only incidents are consulted.**
`Code.js:243` tests that `data.components` exists, then never reads it. `Code.js:246-252` derives status purely from `incidents`, further filtered to `impact !== "none"`.

**Impact:** A vendor that flips a component to `major_outage` **without** opening an incident — common for short blips — reports `Operational`. I proved this reachable by replaying the real Anthropic payload with its incident removed: **4 of 6 components in `major_outage`, `status.indicator: "major"`, and the code returns `"Systems operational."`** The page-level `status.indicator` field is present in every payload and never read.
**Fix:** Read `status.indicator` as the baseline signal, refined by the H3 component allowlist. (Ranked MEDIUM not HIGH only because the incident path catches the common case; H3 is the structural fix for both.)

**M3 — Sheet write is non-atomic: clear-then-write leaves a blank dashboard on failure.**
`Code.js:139-142` clears all existing rows, then writes. There is no transaction.

**Impact:** If `setValues` throws — or the 6-minute execution wall hits between the two — the dashboard is left **empty**, not stale. Readers during the window see partial data. Combined with H2, an adapter shape change produces a crash *after* the clear on the following run.
**Fix:** Build the full row set, then write in one operation; in the port, write to storage transactionally and have the frontend read the last complete snapshot.

**M4 — `stripHtml_` is a display cleaner, not a sanitizer — and becomes an XSS vector on the web port.**
`Code.js:354-372` strips tags with `replace(/<[^>]*>/g, "")`, a regex that is not a sanitizer.

**Impact:** Benign today — output lands in a Google Sheet cell, which does not execute markup. **It stops being benign the moment this content is rendered into an HTML page.** Incident descriptions are attacker-influenced content from ~35 third parties: a compromised or sloppy vendor status page is untrusted input, and this is the boundary where it enters your site. Carrying this function forward unchanged would be a real vulnerability on a public page.
**Fix:** In the port, never render vendor HTML. Escape on output by default, or sanitize with a maintained library. Treat every vendor field as untrusted at the boundary.

**M5 — Fetches are sequential with no timeouts.**
The orchestrator (`Code.js:62-125`) awaits each vendor in turn; no `UrlFetchApp` call sets a deadline.

**Impact:** Runtime scales linearly with vendor count, and one slow endpoint stalls every vendor behind it — pushing toward Apps Script's 6-minute wall and the daily trigger-runtime budget as the fleet grows. Not currently failing, but it is the constraint that caps how many services you can monitor.
**Fix:** Dissolved by the port — `Promise.allSettled` with a per-fetch `AbortSignal.timeout()`. ~40 vendors in roughly the time of the slowest one.

### LOW

**L1 — ~73 lines of dead code.** `fetchTableauStatus_` (`Code.js:386-458`) is never called; Tableau is handled by `fetchSalesforceStatus_` (`Code.js:87`). Two divergent implementations of the same vendor invite editing the wrong one. **Fix:** delete; do not port.

**L2 — Stale User-Agent spoofing.** `Code.js:335` and `:675` claim Chrome 91 (mid-2021). **Impact:** an obviously-forged five-year-old UA is *more* likely to be filtered by bot protection than an honest one — plausibly related to the `status.freshworks.com` 403. **Fix:** send an honest identifying UA with a contact URL; vendors generally welcome well-behaved status pollers.

**L3 — Header check reads one cell.** `Code.js:349-352` compares only `[0][0]`, so any column drift after the first goes undetected. **Fix:** compare the full header row.

**L4 — The `FILTERS` config has itself drifted.** `"DNS"` is configured for Cloudflare (`Code.js:47`) but **is not a component name** in Cloudflare's current payload (verified). Dead config that nobody noticed was dead — because of H3. **Fix:** validate configured component names against the live payload and warn on no-match.

---

## Strengths (verified)

Named with the same evidence standard, because these are what should carry forward:

1. **Per-vendor failure isolation is correctly designed.** `Code.js:62-125` — every adapter call sits in its own `try/catch`, so one vendor's outage or shape change degrades exactly one row rather than the run. This is the right architecture and it should be preserved verbatim in the port. (H4 is a flaw in *what* the handlers return, not in the isolation itself.)
2. **Secrets hygiene is clean.** `.clasp.json`, `creds.json`, and `AGENTS.md` are gitignored **and were never committed** — verified against full history, not just the working tree. No credential has ever entered the repo.
3. **OAuth scopes are genuinely least-privilege.** `appsscript.json` pins `spreadsheets.currentonly` + `script.external_request` and resists Apps Script's auto-detection, which over-reaches. Documented as a settled decision in `CLAUDE.md:49-51`.
4. **The schema guard has the right instinct.** Validating every row against `HEADERS.length` before writing is exactly correct defensive design. Only the implementation is broken (H2) — the idea should port unchanged.
5. **Repository infrastructure is strong for a solo project.** release-please automation, gitleaks over full history, CFF validation, a Mermaid render gate, SHA-pinned Actions, Dependabot, and a `CLAUDE.md` recording settled decisions with their rationale (including a real bash-3.2 bug and why the badges are absent). This is better than most of what it will sit next to on GitHub.
6. **The adapters encode real, hard-won domain knowledge.** Okta's Atom feed with namespace handling, Salesforce's production-instance filtering, Apple's JS-wrapped JSON (`Code.js:378` — slicing between the first `{` and last `}`), Statuspage's underscore-prefixed metadata incidents (`Code.js:248`). **This is the asset.** None of it is obvious, all of it was learned by hitting the real endpoints, and it is the reason a rewrite should port rather than restart.

---

## Recommended remediation order

Not "fix the Apps Script" — sequence for the port.

**Tier 1 — do these first; they are the port's acceptance criteria**
1. **H3 (component allowlist)** — unlocks correct status *and* the severity sort. Everything else keys off it.
2. **M1 (severity enum)** — required by your down-first sort requirement.
3. **H1 (Microsoft)** — decide honestly: implement it or drop the row. Do not carry a permanently-green row into a public dashboard.
4. **H4 → `Unknown` state** — adopt Stormboard's fail-closed convention fleet-wide.

**Tier 2 — free wins from the port itself**
5. **H2, M3, M5** — evaporate under typed rows, transactional writes, and `Promise.allSettled` + timeouts. Verify they're gone; don't assume.
6. **H5 (tests)** — the 25 payloads I fetched are already on disk. Land them as golden fixtures with the first adapter.

**Tier 3 — new-surface risk introduced by the port**
7. **M4 (output escaping)** — this is the one finding that gets *worse* in the new architecture. Treat vendor content as untrusted at the render boundary; make it a test.

**Tier 4 — cleanup**
8. **L1** delete dead code · **L2** honest UA · **L3** full header compare · **L4** validate config against live payloads.

**Explicitly out of scope / decided elsewhere:** the Paylocity and Freshdesk/Freshservice monitoring gaps (no public endpoints found — recorded in internal notes), and an internal share-vs-reimplement decision.

---

## Addendum — findings surfaced while capturing fixtures (2026-07-30)

**H6 — Stormboard has been permanently green for an unknown period: the vendor
migrated off Statuspage and the adapter never noticed.**

`Code.js:39` configures `https://status.stormboard.com/api/v2/summary.json`.
Stormboard has since moved to **Better Stack**, and that URL now returns the
Better Stack HTML page (`200`, `text/html`) rather than Statuspage JSON.

`fetchStormboardStatus_` handles this "gracefully" — it falls through to its
HTML path (`Code.js:190-211`), whose first test is:

```js
if (/all systems operational/i.test(html) || /\boperational\b/i.test(html))
```

That second alternative is a **bare word match anywhere in the document**. The
word "operational" appears **7 times** in Better Stack's markup regardless of
actual status, so the branch always fires and Stormboard reports `Operational`
unconditionally — verified by replaying the real fetched HTML through the
function's own logic.

**Impact:** a third permanently-green vendor, alongside H1 (Microsoft) and the
fail-open handlers of H4. Worse than H1 in one respect: H1 is at least
*visible* in the source as a hardcoded literal, whereas this one looks like
working scraper code and only broke when the vendor changed platforms. This is
the exact silent-rot failure mode that motivates fixture-pinned tests (H5).

**Fix:** Better Stack exposes **no machine-readable status API** on this page —
`index.json`, `api/v2/summary.json` and `status.json` all return HTML, and
`badge.json` advertises `application/json` but serves an HTML badge widget
(all verified). Options, in preference order:
1. Parse Better Stack's actual DOM structure with a targeted selector, pinned
   by a fixture, failing to `UNKNOWN` when the structure changes.
2. Drop Stormboard rather than carry a fourth green-by-accident row.

**Never** retain a bare `/\boperational\b/` document-wide match. Any HTML
adapter must assert on structure and fail closed.

**Related, same sweep:**
- `status.okta.com/history.atom` returns **401**; the legacy FeedBurner URL in
  `Code.js:32` still serves a valid 200 Atom feed with 200 entries. Working,
  but on a deprecated Google property — a single point of silent failure worth
  a fixture and an `UNKNOWN` fallback.
- Apple's endpoint now returns **plain JSON**, not the JS-wrapped form the
  `indexOf('{')` slice at `Code.js:378` was written for. The slice is harmless
  on plain JSON, so this is latent cleanup, not a defect.

**H7 — Concur has also been permanently green: the status page became a
client-side app and the scraper never noticed.**

`open.concur.com` is now a React application. The served HTML is an empty
shell — 58 characters of visible text, reading "Concur Open You need to enable
JavaScript to run this app." The strings the scraper looks for
(`Code.js:473-474`) appear **zero** times:

| Sought | Occurrences in the real page |
|---|---|
| `Disruption` / `status-disruption` | 0 |
| `Degradation` / `status-degradation` | 0 |

So `hasDisruption` and `hasDegradation` are both false and the function returns
`Operational`. The guard that exists precisely to catch this —
`if (!html.includes("Concur"))` → *"Could not verify page content (Scrape
Failed)"* — **passes**, because the word "Concur" sits in the empty shell's
`<title>`. Verified by replaying the real fetched HTML through the function's
own logic.

**Fix (implemented):** the React app calls a JSON API, discovered by reading
its bundle (`/static/js/main.*.chunk.js`):

- `https://open.concur.com/api/open/incidents` — 200 `application/json`,
  incidents carrying `affected_services`, `data_centers`, `status`,
  `severity`, `end_epoch`
- `https://open.concur.com/api/v3/banner` — 200 `application/json`,
  `data.display` is Concur's own "something is wrong" flag

The new adapter uses both, treats a past `end_epoch` as closed, and supports
scoping to a data centre (e.g. `US2`).

### Revised tally of green-by-accident vendors

| Finding | Vendor | Mechanism |
|---|---|---|
| H1 | Microsoft | fetches the endpoint, discards it, returns a hardcoded literal |
| H6 | Stormboard | vendor moved to Better Stack; bare `/\boperational\b/` matches its markup |
| H7 | Concur | vendor became a JS app; scraped strings vanished, sanity guard defeated by `<title>` |
| H4 | Concur, StatusGator | network error returns a row whose status column reads `Operational` |

**Four of the mechanisms above are independent.** The common cause is not any
single bug but the absence of a test that asserts an adapter's output against a
recorded payload — finding H5. Every one of these would have failed red on the
first fixture-pinned assertion.

---

## Local-development note (not a defect)

`Apple` reports `unknown` during a local collection run on **a host with no IPv6 egress** while
every other vendor succeeds. This is an environment artefact, not a code or
vendor problem:

- `curl -6 https://www.apple.com/` fails to connect in ~26 ms; `curl -4`
  returns 200. This host has no working IPv6 egress.
- Node's `fetch` (undici) attempts the AAAA addresses first and hits its
  connect timeout; `curl` falls back to IPv4 automatically.
- Apple is the only configured vendor whose hostname returns AAAA records, so
  it is the only one affected.

It will not reproduce in a Cloudflare Worker, whose `fetch` runs on
Cloudflare's own network. The correct behaviour was observed: the adapter
returned `UNKNOWN` with a warning rather than a green row, which is finding H4
working as designed.

Recorded because it is precisely the kind of local-network artefact that
invites a "fix" to code that is not broken.
