# Endpoint-Rot Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect vendors stuck at `unknown` for 6+ hours, diagnose the endpoint deterministically, file a labeled GitHub issue (+ optional Slack webhook), and auto-close on recovery.

**Architecture:** The Worker tracks consecutive-unknown streaks in a new D1 `vendor_health` table (written in `writeRun`'s existing transactional batch) and exposes `unknownSince` on `/api/status`. A scheduled GitHub Action polls the API, runs a probe-then-classify diagnosis script, and manages `endpoint-rot` issues. Spec: `docs/superpowers/specs/2026-08-12-endpoint-rot-watchdog-design.md`.

**Tech Stack:** Cloudflare Worker + D1 (existing), Node ≥18 stdlib only for the diagnosis script, GitHub Actions + `gh` CLI + `jq`, vitest with the real-SQLite D1 shim (`test/helpers/d1.js`).

## Global Constraints

- Governing rule: an unverifiable status is `unknown`, never `operational`. The watchdog observes; it never votes on severity.
- `src/engine/` stays platform-free; everything here touches `src/worker/`, `migrations/`, `scripts/`, `.github/workflows/` only.
- The Action polls `https://vendor-dashboard.gsysd.workers.dev/service-status/api/status` — the **workers.dev origin**, NOT briangreenberg.net: Cloudflare bot management 403-challenges GitHub runners on the public hostname (see the header comment in `.github/workflows/staleness-monitor.yml`).
- Third-party GitHub Actions are pinned by commit SHA — copy the exact pins from `.github/workflows/test.yml` / `staleness-monitor.yml`, never a tag.
- `budgetExhausted` runs must neither start nor clear streaks — operator fault, not vendor rot.
- Threshold 6 h via workflow env `THRESHOLD_HOURS: 6`; cadence cron `17 */2 * * *`.
- Every commit follows Conventional Commits, no Co-Authored-By, push after commit; run `npm test` + `npx eslint .` before each push.
- Milestone 2 (AI fix-proposal job gated on `ANTHROPIC_API_KEY`) is explicitly OUT of this plan — follow-up PR.

---

### Task 1: D1 migration + streak tracking in `writeRun`

**Files:**
- Create: `migrations/0002_vendor_health.sql`
- Modify: `src/worker/storage.js` (inside `writeRun`, statements array; and the prune block)
- Test: `test/worker/storage.test.js` (append a new `describe`)

**Interfaces:**
- Consumes: `writeRun(db, run, options)` where `run.records[]` have `{vendor, severity, checkedAt}`, `run.checkedAt`, `run.budgetExhausted` (boolean, may be undefined), `options.knownVendors` (full configured list or null).
- Produces: D1 table `vendor_health(vendor TEXT PK, failing_since TEXT, failures INTEGER)` maintained per run. Task 2 reads it.

- [ ] **Step 1: Write the migration**

`migrations/0002_vendor_health.sql`:

```sql
-- Endpoint-rot watchdog (spec: docs/superpowers/specs/2026-08-12-endpoint-rot-watchdog-design.md).
-- One row per vendor CURRENTLY failing: failing_since is the first unknown of
-- the active streak, failures the consecutive count. Row absent = healthy.
CREATE TABLE IF NOT EXISTS vendor_health (
  vendor        TEXT PRIMARY KEY,
  failing_since TEXT NOT NULL,
  failures      INTEGER NOT NULL
);
```

The D1 test shim (`test/helpers/d1.js`) applies every `migrations/*.sql` in sorted order automatically, so tests see the table with no further wiring; production gets it from `npm run deploy` (`wrangler d1 migrations apply`).

- [ ] **Step 2: Write the failing tests**

Append to `test/worker/storage.test.js` (match the file's existing style — it builds a db via the helper and calls `writeRun` with literal run objects; read the top of the file for the helper import, typically `makeDb()` or similar — reuse exactly what the existing tests use):

```js
describe('vendor_health — endpoint-rot streak tracking', () => {
  const rec = (vendor, severity, checkedAt = '2026-08-12T00:00:00.000Z') => ({
    vendor, service: vendor, severity, checkedAt,
    incidentName: '', description: '', sourceUrl: '', components: [], warnings: [],
  });
  const run = (records, over = {}) => ({
    records, checkedAt: records[0]?.checkedAt ?? '2026-08-12T00:00:00.000Z',
    total: records.length, impacted: 0, unknown: 0, warnings: [], ...over,
  });
  const health = (db) => db.prepare('SELECT * FROM vendor_health').all();

  it('an unknown collection starts a streak at that run time', async () => {
    const db = makeDb();
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    const rows = (await health(db)).results;
    expect(rows).toEqual([
      { vendor: 'SendGrid', failing_since: '2026-08-12T00:00:00.000Z', failures: 1 },
    ]);
  });

  it('a repeat unknown increments failures but keeps failing_since', async () => {
    const db = makeDb();
    await writeRun(db, run([rec('SendGrid', 'unknown', '2026-08-12T00:00:00.000Z')]));
    await writeRun(db, run([rec('SendGrid', 'unknown', '2026-08-12T00:15:00.000Z')]));
    const rows = (await health(db)).results;
    expect(rows[0].failing_since).toBe('2026-08-12T00:00:00.000Z');
    expect(rows[0].failures).toBe(2);
  });

  it('recovery clears the streak', async () => {
    const db = makeDb();
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    await writeRun(db, run([rec('SendGrid', 'degraded', '2026-08-12T00:15:00.000Z')]));
    expect((await health(db)).results).toEqual([]);
  });

  it('a budget-exhausted run neither starts nor clears streaks', async () => {
    const db = makeDb();
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    // Exhausted run: SendGrid "recovers" and Zoom "fails" — neither may count.
    await writeRun(db, run(
      [rec('SendGrid', 'operational', '2026-08-12T00:15:00.000Z'),
       rec('Zoom', 'unknown', '2026-08-12T00:15:00.000Z')],
      { budgetExhausted: true },
    ));
    const rows = (await health(db)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].vendor).toBe('SendGrid');
    expect(rows[0].failures).toBe(1);
  });

  it('a vendor removed from config loses its streak row (no orphaned alarms)', async () => {
    const db = makeDb();
    await writeRun(db, run([rec('Ghost', 'unknown')]));
    await writeRun(db, run([rec('Zoom', 'operational', '2026-08-12T00:15:00.000Z')]),
      { knownVendors: ['Zoom'] });
    expect((await health(db)).results).toEqual([]);
  });

  it('a shard only touches its own vendors’ streaks', async () => {
    const db = makeDb();
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    await writeRun(db, run([rec('Zoom', 'operational', '2026-08-12T00:15:00.000Z')]));
    expect((await health(db)).results).toHaveLength(1); // SendGrid streak survives
  });
});
```

- [ ] **Step 3: Run to verify they fail** — `npx vitest run test/worker/storage.test.js` — expect failures like `no such table: vendor_health` is NOT acceptable (migration exists after Step 1); expected failure mode: rows missing (`expected [] to equal [...]`).

- [ ] **Step 4: Implement in `writeRun`**

In `src/worker/storage.js`, add to the `prune` block (a removed vendor must not alarm forever):

```js
const prune =
  known && known.length > 0
    ? [
        db
          .prepare(`DELETE FROM snapshot WHERE vendor NOT IN (${known.map(() => '?').join(',')})`)
          .bind(...known),
        db
          .prepare(`DELETE FROM vendor_health WHERE vendor NOT IN (${known.map(() => '?').join(',')})`)
          .bind(...known),
      ]
    : [];
```

And insert into the `statements` array (after the history insert, before retention):

```js
// ENDPOINT-ROT WATCHDOG. Streaks ride the same transactional batch as the
// snapshot so board and streaks can never disagree. ON CONFLICT deliberately
// leaves failing_since alone — it marks the FIRST unknown of the streak.
// Skipped wholesale on budget-exhausted runs: those unknowns are an operator
// fault (see collection_alert), not vendor rot, and must neither start nor
// clear a streak.
...(run.budgetExhausted
  ? []
  : run.records.map((r) =>
      r.severity === 'unknown'
        ? db
            .prepare(
              `INSERT INTO vendor_health (vendor, failing_since, failures)
               VALUES (?, ?, 1)
               ON CONFLICT(vendor) DO UPDATE SET failures = failures + 1`,
            )
            .bind(r.vendor, r.checkedAt ?? run.checkedAt)
        : db.prepare('DELETE FROM vendor_health WHERE vendor = ?').bind(r.vendor),
    )),
```

- [ ] **Step 5: Run tests to verify pass** — `npx vitest run test/worker/storage.test.js`, then full `npm test` (all suites) + `npx eslint .`.

- [ ] **Step 6: Commit** — `git add migrations/0002_vendor_health.sql src/worker/storage.js test/worker/storage.test.js && git commit -m "feat: track consecutive-unknown streaks in D1 vendor_health" && git push`

---

### Task 2: `unknownSince` on `/api/status`

**Files:**
- Modify: `src/worker/storage.js` (`readSnapshot`)
- Test: `test/worker/storage.test.js` (extend the Task 1 describe), plus one pass-through assertion in `test/worker/contract.test.js` if that file exercises `/api/status` (read it first; if it asserts the record shape, extend that assertion — otherwise the storage test suffices).

**Interfaces:**
- Consumes: `vendor_health` from Task 1.
- Produces: each record from `readSnapshot` gains optional `unknownSince: string` (ISO-8601) **iff** a `vendor_health` row exists; the field is absent otherwise. Task 3's Action selects on `.unknownSince != null`.

- [ ] **Step 1: Write the failing test** (same describe as Task 1):

```js
it('readSnapshot carries unknownSince only for vendors with an active streak', async () => {
  const db = makeDb();
  await writeRun(db, run([
    rec('SendGrid', 'unknown'),
    rec('Zoom', 'operational'),
  ]));
  const { records } = await readSnapshot(db);
  const sg = records.find((r) => r.vendor === 'SendGrid');
  const zoom = records.find((r) => r.vendor === 'Zoom');
  expect(sg.unknownSince).toBe('2026-08-12T00:00:00.000Z');
  expect('unknownSince' in zoom).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/worker/storage.test.js` — expected: `sg.unknownSince` undefined.

- [ ] **Step 3: Implement in `readSnapshot`**

```js
const [rows, meta, health] = await Promise.all([
  db.prepare('SELECT * FROM snapshot').all(),
  db.prepare('SELECT * FROM run_meta WHERE id = 1').first(),
  db.prepare('SELECT vendor, failing_since FROM vendor_health').all(),
]);

// Streak start per failing vendor — absent field = healthy, so old clients
// and the renderer see an unchanged shape.
const failingSince = new Map(
  (health?.results ?? []).map((h) => [h.vendor, h.failing_since]),
);
```

and in the record mapper add:

```js
    ...(failingSince.has(r.vendor) ? { unknownSince: failingSince.get(r.vendor) } : {}),
```

- [ ] **Step 4: Run tests** — file, then `npm test` + eslint.
- [ ] **Step 5: Commit** — `git commit -m "feat: expose unknownSince on /api/status for streak-failing vendors"` (with the touched files) `&& git push`.

---

### Task 3: Diagnosis script — pure classifier + thin probes

**Files:**
- Create: `scripts/watchdog/classify.mjs` (pure — zero network, unit-tested)
- Create: `scripts/watchdog/diagnose-endpoint.mjs` (CLI: probes, calls classify, prints a markdown diagnosis to stdout)
- Test: `test/scripts/classify.test.js` (new directory; vitest picks up `test/**` automatically — verify with the run)

**Interfaces:**
- Produces: `classify(probe) -> {classification: string, headline: string, suggestedFix: string}` where `probe = {host, dns: {ok, chain, error?}, tls: {ok, matchesHost, subject?, error?}, http: {ok, status?, redirects: [{status, location}], finalHost?, bodyIsJson?, error?}}`. Classifications: `dns-failure | tls-cert-mismatch | decommissioned | http-client-error | http-server-error | body-not-json | endpoint-ok-likely-adapter-drift`.
- CLI contract for Task 4: `node scripts/watchdog/diagnose-endpoint.mjs <url>` exits 0 and prints markdown with a `Classification: <value>` line plus fenced evidence.

- [ ] **Step 1: Write the failing classifier tests**

`test/scripts/classify.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { classify } from '../../scripts/watchdog/classify.mjs';

const base = {
  host: 'status.example.com',
  dns: { ok: true, chain: ['status.example.com', 'pages.example-status-host.com'] },
  tls: { ok: true, matchesHost: true, subject: 'CN=status.example.com' },
  http: { ok: true, status: 200, redirects: [], finalHost: 'status.example.com', bodyIsJson: true },
};

describe('classify — precedence ladder', () => {
  it('DNS failure outranks everything', () => {
    const r = classify({ ...base, dns: { ok: false, chain: [], error: 'ENOTFOUND' } });
    expect(r.classification).toBe('dns-failure');
  });

  it('the SendGrid signature: wrong cert + off-host redirect classifies as the cert mismatch first', () => {
    // Live capture 2026-08-12: CNAME to stspg-customer.com serving *.statuspage.io.
    const r = classify({
      ...base,
      host: 'status.sendgrid.com',
      dns: { ok: true, chain: ['status.sendgrid.com', '3tgl2vf85cht.stspg-customer.com'] },
      tls: { ok: true, matchesHost: false, subject: 'CN=*.statuspage.io' },
      http: { ok: true, status: 302, redirects: [{ status: 302, location: 'https://www.statuspage.io' }], finalHost: 'www.statuspage.io', bodyIsJson: false },
    });
    expect(r.classification).toBe('tls-cert-mismatch');
    expect(r.suggestedFix).toMatch(/decommission|moved|new status page/i);
  });

  it('an off-host redirect with a VALID cert is a decommissioned page', () => {
    const r = classify({
      ...base,
      http: { ok: true, status: 302, redirects: [{ status: 302, location: 'https://www.statuspage.io' }], finalHost: 'www.statuspage.io', bodyIsJson: false },
    });
    expect(r.classification).toBe('decommissioned');
  });

  it('4xx and 5xx classify separately (a 401 needs a different fix than a 503)', () => {
    expect(classify({ ...base, http: { ...base.http, status: 404, bodyIsJson: false } }).classification)
      .toBe('http-client-error');
    expect(classify({ ...base, http: { ...base.http, status: 503, bodyIsJson: false } }).classification)
      .toBe('http-server-error');
  });

  it('200 but not JSON is a reshape', () => {
    const r = classify({ ...base, http: { ...base.http, bodyIsJson: false } });
    expect(r.classification).toBe('body-not-json');
  });

  it('a healthy endpoint means the ADAPTER drifted, and says so', () => {
    const r = classify(base);
    expect(r.classification).toBe('endpoint-ok-likely-adapter-drift');
    expect(r.suggestedFix).toMatch(/adapter|scope|vocabulary/i);
  });

  it('never throws on a partial probe', () => {
    expect(() => classify({ host: 'x' })).not.toThrow();
    expect(classify({ host: 'x' }).classification).toBe('dns-failure');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/scripts/classify.test.js` — expected: cannot find module `classify.mjs`.

- [ ] **Step 3: Implement `classify.mjs`**

```js
/**
 * Pure classifier over probe results — zero network, so the precedence
 * ladder is unit-testable. Precedence: the earliest broken layer explains
 * everything below it (a dead DNS name makes the TLS/HTTP probes noise).
 */
const PLAYBOOK = {
  'dns-failure':
    'The hostname no longer resolves. Find the vendor’s current status page and repoint config/vendors.json; if none exists, remove the row (a row with no data source reports health it never verified).',
  'tls-cert-mismatch':
    'The served certificate does not cover the hostname — the classic decommissioned-custom-domain signature (SendGrid, 2026-08-12: stale CNAME to Statuspage serving *.statuspage.io). The page has likely moved: find the new status page and repoint, scoping if it is shared (worked example: PR #84).',
  decommissioned:
    'The endpoint redirects off-host — the page is gone. Find the vendor’s new status page and repoint config/vendors.json, scoping if it now shares another vendor’s page (worked example: PR #84).',
  'http-client-error':
    'The endpoint answers 4xx. If 401/403 the feed may have gone private (see the Okta and Freshworks precedents in config); if 404 the path moved — find the current API path from the status page’s network log.',
  'http-server-error':
    'The endpoint answers 5xx — possibly the vendor’s own outage. If it persists for days, treat as rot and look for a replacement endpoint.',
  'body-not-json':
    'The endpoint serves 200 but not JSON — the payload reshaped (often a JS-shell rewrite; see the Adobe precedent in config). Re-derive the real data URL from the page’s network log.',
  'endpoint-ok-likely-adapter-drift':
    'The endpoint is reachable and serves JSON — the rot is on OUR side: the adapter or scope no longer matches the payload (renamed components, new vocabulary). Diff a live payload against the recorded fixture and update adapter/scope/fixtures.',
};

export function classify(probe) {
  const dns = probe?.dns ?? { ok: false, error: 'no probe result' };
  const tls = probe?.tls ?? { ok: false };
  const http = probe?.http ?? { ok: false };

  let classification;
  if (!dns.ok) classification = 'dns-failure';
  else if (tls.ok && tls.matchesHost === false) classification = 'tls-cert-mismatch';
  else if (
    http.finalHost && probe.host && http.finalHost !== probe.host
  ) classification = 'decommissioned';
  else if (typeof http.status === 'number' && http.status >= 500) classification = 'http-server-error';
  else if (typeof http.status === 'number' && http.status >= 400) classification = 'http-client-error';
  else if (http.ok && http.bodyIsJson === false) classification = 'body-not-json';
  else if (http.ok && http.bodyIsJson) classification = 'endpoint-ok-likely-adapter-drift';
  else classification = 'http-server-error'; // unreachable/timeout with live DNS

  return {
    classification,
    headline: `Endpoint diagnosis: ${classification}`,
    suggestedFix: PLAYBOOK[classification],
  };
}
```

NOTE for the implementer: run the tests — the 302-with-valid-cert case must reach `decommissioned` (redirect checked before 4xx/5xx but the 302 status itself must not fall into the 4xx/5xx arms; 302 < 400 so it does not). The redirect arm keys on `finalHost !== host`, so a same-host `/api` → `/api/` redirect stays healthy.

- [ ] **Step 4: Run classifier tests to green.**

- [ ] **Step 5: Implement `diagnose-endpoint.mjs`** (no test — thin probes; the classifier carries the logic):

```js
#!/usr/bin/env node
/**
 * Probe a status endpoint and print a markdown diagnosis (stdout).
 * Node >=18 stdlib only. Usage: node scripts/watchdog/diagnose-endpoint.mjs <url>
 * Evidence is printed in fenced blocks: endpoint content is third-party text
 * and must never be interpolated into markdown structure.
 */
import { resolveCname, resolve4 } from 'node:dns/promises';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import { classify } from './classify.mjs';

const url = new URL(process.argv[2]);
const host = url.hostname;

async function probeDns() {
  const chain = [host];
  try {
    let cur = host;
    for (let i = 0; i < 5; i += 1) {
      const cnames = await resolveCname(cur).catch(() => []);
      if (cnames.length === 0) break;
      cur = cnames[0];
      chain.push(cur);
    }
    await resolve4(chain[chain.length - 1]);
    return { ok: true, chain };
  } catch (e) {
    return { ok: false, chain, error: e?.code ?? String(e) };
  }
}

function probeTls() {
  return new Promise((resolve) => {
    const sock = tlsConnect(
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10_000 },
      () => {
        const cert = sock.getPeerCertificate();
        const mismatch = checkServerIdentity(host, cert);
        resolve({ ok: true, matchesHost: mismatch === undefined, subject: cert?.subject?.CN ?? '' });
        sock.end();
      },
    );
    sock.on('error', (e) => resolve({ ok: false, error: String(e?.code ?? e) }));
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function probeHttp() {
  const redirects = [];
  let cur = url.href;
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(cur, {
        redirect: 'manual',
        headers: { 'User-Agent': 'vendor-dashboard-watchdog (+https://github.com/bjgreenberg/vendor-dashboard)' },
        signal: AbortSignal.timeout(15_000),
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        redirects.push({ status: res.status, location: loc });
        cur = new URL(loc, cur).href;
        continue;
      }
      const body = await res.text();
      let bodyIsJson = false;
      try { JSON.parse(body); bodyIsJson = true; } catch { /* not JSON */ }
      return { ok: true, status: res.status, redirects, finalHost: new URL(cur).hostname, bodyIsJson };
    }
    return { ok: true, status: 310, redirects, finalHost: new URL(cur).hostname, bodyIsJson: false };
  } catch (e) {
    return { ok: false, redirects, error: String(e?.cause?.code ?? e?.name ?? e) };
  }
}

const probe = { host, dns: await probeDns(), tls: await probeTls(), http: await probeHttp() };
const verdict = classify(probe);

console.log(`## ${verdict.headline}

**URL probed:** \`${url.href}\`
**Classification:** \`${verdict.classification}\`

**Suggested fix:** ${verdict.suggestedFix}

### Evidence

\`\`\`json
${JSON.stringify(probe, null, 2)}
\`\`\`
`);
```

- [ ] **Step 6: Smoke it against a live healthy endpoint** — `node scripts/watchdog/diagnose-endpoint.mjs https://status.anthropic.com/api/v2/summary.json` → expect `endpoint-ok-likely-adapter-drift` (reachable JSON; the "rot" framing only applies when the board disagrees — note this is the smoke test, not a claim). Full suite + eslint (eslint covers `scripts/`? — check `eslint.config` ignores; if scripts are linted, fix any findings).

- [ ] **Step 7: Commit** — `git commit -m "feat: watchdog diagnosis — pure classifier with probe CLI"` `&& git push`.

---

### Task 4: The watchdog workflow

**Files:**
- Create: `.github/workflows/endpoint-rot-watchdog.yml`

**Interfaces:**
- Consumes: `unknownSince` from the API (Task 2), the CLI contract from Task 3, repo secret `WATCHDOG_WEBHOOK_URL` (already set), `GITHUB_TOKEN`.
- Produces: issues labeled `endpoint-rot`, titled `endpoint-rot: <vendor>`.

- [ ] **Step 1: Write the workflow** (SHA-pin `actions/checkout` and `actions/setup-node` — copy the exact `uses:` pins from `.github/workflows/test.yml`):

```yaml
name: Endpoint-rot watchdog

# Per-vendor sibling of the dead-man monitor (staleness-monitor.yml): that one
# watches whole-board freshness; this one watches a single vendor stuck at
# `unknown` past the threshold — the SendGrid-2026-08-12 class of rot. Probes
# the workers.dev origin because Cloudflare bot management challenges GitHub
# runners on the public hostname (same reason as the dead-man monitor).
# Design: docs/superpowers/specs/2026-08-12-endpoint-rot-watchdog-design.md

on:
  schedule:
    - cron: '17 */2 * * *'
  workflow_dispatch:

permissions:
  contents: read
  issues: write

env:
  API: https://vendor-dashboard.gsysd.workers.dev/service-status/api/status
  THRESHOLD_HOURS: 6
  GH_TOKEN: ${{ github.token }}

jobs:
  watchdog:
    runs-on: ubuntu-latest
    steps:
      - uses: <SHA-pinned actions/checkout from test.yml>
      - uses: <SHA-pinned actions/setup-node from test.yml>
        with:
          node-version: 22

      - name: Ensure label exists
        run: gh label create endpoint-rot --repo "$GITHUB_REPOSITORY" --description "A vendor status endpoint has rotted" --color B60205 --force

      - name: Find rotted vendors and file issues
        run: |
          set -euo pipefail
          curl -sf --max-time 30 "$API" -o status.json
          now=$(date -u +%s)
          rotted=$(jq -r --argjson now "$now" --argjson hrs "$THRESHOLD_HOURS" '
            .records[] | select(.unknownSince != null)
            | select(($now - (.unknownSince | sub("\\.[0-9]+Z$"; "Z") | fromdate)) > ($hrs * 3600))
            | .vendor' status.json)
          [ -z "$rotted" ] && { echo "no vendor past the ${THRESHOLD_HOURS}h threshold"; exit 0; }
          while IFS= read -r vendor; do
            open=$(gh issue list --repo "$GITHUB_REPOSITORY" --label endpoint-rot --state open \
                     --search "\"endpoint-rot: $vendor\" in:title" --json number --jq length)
            if [ "$open" != "0" ]; then echo "issue already open for $vendor"; continue; fi
            url=$(jq -r --arg v "$vendor" '.vendors[] | select(.name == $v) | .url' config/vendors.json)
            since=$(jq -r --arg v "$vendor" '.records[] | select(.vendor == $v) | .unknownSince' status.json)
            {
              echo "The board has reported **$vendor** as \`unknown\` continuously since \`$since\` (threshold: ${THRESHOLD_HOURS}h)."
              echo
              node scripts/watchdog/diagnose-endpoint.mjs "$url"
              echo
              echo "_Filed automatically by the endpoint-rot watchdog. It will comment and close this issue if the vendor recovers._"
            } > body.md
            issue_url=$(gh issue create --repo "$GITHUB_REPOSITORY" --label endpoint-rot \
              --title "endpoint-rot: $vendor" --body-file body.md)
            echo "filed $issue_url"
            if [ -n "${WEBHOOK:-}" ]; then
              text=$(jq -rn --arg v "$vendor" --arg u "$issue_url" \
                '{text: ("vendor-dashboard watchdog: \($v) status endpoint has rotted — \($u)")} | @json')
              curl -sf --max-time 15 -X POST -H 'Content-type: application/json' --data "$text" "$WEBHOOK" >/dev/null || echo "webhook post failed (non-fatal)"
            fi
          done <<< "$rotted"
        env:
          WEBHOOK: ${{ secrets.WATCHDOG_WEBHOOK_URL }}

      - name: Close recovered issues
        run: |
          set -euo pipefail
          curl -sf --max-time 30 "$API" -o status.json
          gh issue list --repo "$GITHUB_REPOSITORY" --label endpoint-rot --state open \
            --json number,title --jq '.[] | "\(.number)\t\(.title)"' |
          while IFS=$'\t' read -r number title; do
            vendor=${title#endpoint-rot: }
            state=$(jq -r --arg v "$vendor" '[.records[] | select(.vendor == $v)] | first | .severity // "gone"' status.json)
            still=$(jq -r --arg v "$vendor" '[.records[] | select(.vendor == $v)] | first | .unknownSince // empty' status.json)
            if [ "$state" != "unknown" ] || [ -z "$still" ]; then
              gh issue comment "$number" --repo "$GITHUB_REPOSITORY" \
                --body "Recovered: the board now reports \`$state\` for $vendor. Closing."
              gh issue close "$number" --repo "$GITHUB_REPOSITORY"
              if [ -n "${WEBHOOK:-}" ]; then
                curl -sf --max-time 15 -X POST -H 'Content-type: application/json' \
                  --data "$(jq -rn --arg v "$vendor" '{text: ("vendor-dashboard watchdog: \($v) recovered — issue closed.")} | @json')" \
                  "$WEBHOOK" >/dev/null || echo "webhook post failed (non-fatal)"
              fi
            fi
          done
        env:
          WEBHOOK: ${{ secrets.WATCHDOG_WEBHOOK_URL }}
```

Implementation notes for this step, all mandatory:
- Replace both `<SHA-pinned …>` placeholders with the exact `uses:` lines (including comments) from `.github/workflows/test.yml`.
- `jq`'s `fromdate` rejects fractional seconds — the `sub("\\.[0-9]+Z$"; "Z")` guard is load-bearing; `checkedAt`/`failing_since` carry milliseconds.
- Untrusted-data rule from `references/github-actions.md`: no `${{ }}` interpolation into `run:` beyond `github.token`/`secrets` — vendor names flow through files and shell vars, never expression interpolation. Vendor names come from OUR config (trusted-ish), but the rule is followed anyway.
- The webhook is optional by construction: `${WEBHOOK:-}` empty → skipped silently.

- [ ] **Step 2: Lint the workflow** — run `npx actionlint` if available locally, else rely on CI's workflow gates; validate YAML parses: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/endpoint-rot-watchdog.yml'))"`.

- [ ] **Step 3: Commit** — `git commit -m "feat: endpoint-rot watchdog workflow — issues, recovery closes, optional webhook"` `&& git push`.

---

### Task 5: Documentation (same PR, before it opens)

**Files:**
- Modify: `README.md` (new "Endpoint-rot watchdog" section next to the dead-man-monitor/monitoring docs; extend the architecture Mermaid diagram with the watchdog flow)
- Modify: `CLAUDE.md` ("Verifying a deploy" gains the watchdog as a signal source; settled-decisions bullet for streak semantics)

- [ ] **Step 1: README** — add a section covering: what fires (6 h continuous unknown), what arrives (labeled issue with classification + evidence + fix playbook; optional Slack webhook via the `WATCHDOG_WEBHOOK_URL` secret; forks need zero config), what auto-closes, and the workers.dev-origin reason. Extend the existing architecture diagram (`README.md` block1 or block2 — read them, pick the one showing collection flow) with the `vendor_health` table and the Action. Bump the README `Last updated:` stamp via `TZ='America/Chicago' date '+%Y-%m-%d %I:%M %p %Z'`.
- [ ] **Step 2: CLAUDE.md** — in *Verifying a deploy*, add: persistent unknowns now surface as `unknownSince` on the API and 6 h+ files an `endpoint-rot` issue. In settled decisions: streaks are budget-exhaustion-blind and cleared by config removal (prune) — do not "fix" either.
- [ ] **Step 3: Render-check** — `bash scripts/render-diagrams.sh` (must PASS; docs-render is a required check).
- [ ] **Step 4: Full suite + eslint**, then commit — `git commit -m "docs: endpoint-rot watchdog — README section, architecture diagram, CLAUDE.md verification notes"` `&& git push`.

---

### Task 6: PR, gates, deploy, live rehearsal

- [ ] **Step 1:** `gh pr create` — What/Why/Testing body referencing the spec; wait for all ten checks.
- [ ] **Step 2:** Triage bot review comments (address or reply-dismiss each), re-push as needed.
- [ ] **Step 3:** Merge (squash, auto-merge after `gh pr update-branch` if BEHIND), pull main, `npm run deploy` (applies the D1 migration + new worker).
- [ ] **Step 4:** Verify per CLAUDE.md across a full cycle: `/api/status` records healthy vendors carry NO `unknownSince`; `/health` 200. Then a live rehearsal: `gh workflow run endpoint-rot-watchdog.yml` and confirm the run logs "no vendor past the 6h threshold" (nothing on the board should be 6 h rotted today) and that no spurious issue was filed.
- [ ] **Step 5:** Update memory (`project_vendor_dashboard_watchdog.md` → shipped state; milestone 2 = AI job still open) and report.
