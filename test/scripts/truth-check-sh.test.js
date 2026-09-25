import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// scripts/truth-check/check.sh is the ONE orchestration both runners execute:
// the GitHub workflow (every two hours, the external backstop) and hume's
// hourly launchd job (2026-09-25, the primary — GitHub's cron dropped slots
// and the board read "Truth check overdue" on a scheduling miss). These
// tests pin its contract against stub tools: curl (the board), gh (issues),
// node (run.mjs has its own tests; here it is a report fixture) and sleep.
// Nothing here touches the network, GitHub, or the real keychain.

const REPO = resolve(__dirname, '../..');
const CHECK = join(REPO, 'scripts/truth-check/check.sh');
const HUME = join(REPO, 'scripts/truth-check/hume.sh');

const REPORT_CLEAN = {
  checkedAt: '2026-09-25T06:00:00Z',
  covered: 3,
  total: 4,
  agreed: 3,
  falseGreen: [],
};
const REPORT_FALSE_GREEN = {
  ...REPORT_CLEAN,
  agreed: 2,
  falseGreen: [
    { vendor: 'Cloudflare', rendered: 'operational', evidence: ['indicator: major'], urls: ['https://example.test/api'] },
  ],
};
const STATUS = { meta: { checked_at: '2026-09-25T05:59:00Z' }, records: [{ vendor: 'Cloudflare', severity: 'operational' }] };

let dir;
let bin;
let work;

function stub(name, body) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function stubs({ report = REPORT_CLEAN, openIssue = '' } = {}) {
  writeFileSync(join(dir, 'report.fixture.json'), JSON.stringify(report));
  writeFileSync(join(dir, 'status.fixture.json'), JSON.stringify(STATUS));
  // curl: GET /api/status → the fixture; POST /api/truth-check → record the
  // stamp body and answer 204 the way the Worker does.
  stub(
    'curl',
    `args="$*"
out=""; data=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; --data) data="$2"; shift;; esac; shift; done
case "$args" in
  *"/api/status"*) cp "${dir}/status.fixture.json" "$out"; exit 0;;
  *"/api/truth-check"*) : > "$out"; cp "\${data#@}" "${dir}/stamp.posted.json"; printf '204'; exit 0;;
esac
exit 22`,
  );
  // gh: record every call; issue list answers the open-issue seam; create prints a URL.
  stub(
    'gh',
    `echo "$*" >> "${dir}/gh.calls"
case "$1 $2" in
  "issue list") if [[ "$*" == *"--json number"* ]]; then printf '%s' "${openIssue}"; else printf ''; fi;;
  "issue create") echo "https://github.com/x/y/issues/77";;
esac
exit 0`,
  );
  // node: run.mjs stands in for a report fixture; the summary line goes to stdout.
  stub(
    'node',
    `out=""; while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done
cp "${dir}/report.fixture.json" "$out"; echo "fixture summary"`,
  );
  stub('sleep', 'exit 0');
}

function run(script, env = {}, cwd = work) {
  const r = spawnSync('/bin/bash', [script], {
    cwd,
    env: {
      HOME: join(dir, 'home'),
      PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`,
      ORIGIN: 'https://board.test/service-status',
      GITHUB_REPOSITORY: 'x/y',
      GH_TOKEN: 'stub',
      TRUTH_CHECK_CONFIRM_DELAY_S: '0',
      ...env,
    },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'truth-check-sh-'));
  bin = join(dir, 'bin');
  work = join(dir, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  mkdirSync(join(dir, 'home', 'Library', 'Logs'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('check.sh — the shared truth-check orchestration', () => {
  it('a clean pass exits 0, ensures the label, files nothing, and stamps the board', () => {
    stubs();
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't' });
    expect(r.code, r.err).toBe(0);
    const calls = readFileSync(join(dir, 'gh.calls'), 'utf8');
    expect(calls).toMatch(/^label create truth-check/m);
    expect(calls).not.toMatch(/issue create/);
    const stamp = JSON.parse(readFileSync(join(dir, 'stamp.posted.json'), 'utf8'));
    expect(stamp).toEqual({
      checkedAt: '2026-09-25T06:00:00Z',
      covered: 3,
      total: 4,
      agreed: 3,
      disagreements: 0,
      falseGreen: [],
    });
    expect(r.out).toMatch(/stamp HTTP 204/);
  });

  it('a NEW false green is confirmed, filed as an issue, stamped, and exits 3', () => {
    stubs({ report: REPORT_FALSE_GREEN });
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't' });
    expect(r.code, r.err).toBe(3);
    const calls = readFileSync(join(dir, 'gh.calls'), 'utf8');
    expect(calls).toMatch(/issue create .*--title truth-check: Cloudflare/);
    const stamp = JSON.parse(readFileSync(join(dir, 'stamp.posted.json'), 'utf8'));
    expect(stamp.disagreements).toBe(1);
    expect(stamp.falseGreen).toEqual(['Cloudflare']);
    expect(r.out).toMatch(/1 new disagreement/);
  });

  it('a false green already filed is refreshed, not re-filed, and exits 0', () => {
    stubs({ report: REPORT_FALSE_GREEN, openIssue: '41' });
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't' });
    expect(r.code, r.err).toBe(0);
    const calls = readFileSync(join(dir, 'gh.calls'), 'utf8');
    expect(calls).toMatch(/issue comment 41/);
    expect(calls).not.toMatch(/issue create/);
  });

  it('without TRUTH_CHECK_TOKEN the compare still runs and the stamp step is skipped, loudly', () => {
    stubs();
    const r = run(CHECK, {});
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(dir, 'stamp.posted.json'))).toBe(false);
    expect(r.out).toMatch(/TRUTH_CHECK_TOKEN not configured/);
  });

  it('a board that cannot be fetched is a failure, not a clean pass (exit ≠ 0, ≠ 3)', () => {
    stubs();
    stub('curl', 'exit 22');
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't' });
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(3);
    expect(existsSync(join(dir, 'stamp.posted.json'))).toBe(false);
  });
});

describe('hume.sh — the launchd runner around check.sh', () => {
  const secrets = (pat, token) =>
    stub(
      'security',
      `case "$*" in
  *vendor-dashboard-truth-check-pat*) ${pat ? `printf '%s' '${pat}'; exit 0` : 'exit 44'};;
  *vendor-dashboard-truth-check-token*) ${token ? `printf '%s' '${token}'; exit 0` : 'exit 44'};;
esac; exit 44`,
    );
  const env = () => ({
    TRUTH_CHECK_SECURITY_BIN: join(bin, 'security'),
    TRUTH_CHECK_HOST: 'hume',
    TRUTH_CHECK_REPO_DIR: REPO,
  });
  const stampFile = () => join(dir, 'home', '.local', 'state', 'vendor-dashboard-truth-check', 'last-success');
  const logFile = () => join(dir, 'home', 'Library', 'Logs', 'vendor-dashboard-truth-check.log');

  it('a completed check writes the success stamp and the log', () => {
    stubs();
    secrets('pat', 'tok');
    const r = run(HUME, env());
    expect(r.code, r.err).toBe(0);
    expect(existsSync(stampFile())).toBe(true);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/stamp HTTP 204/);
    // The secrets reached check.sh as env, and never the log.
    expect(readFileSync(logFile(), 'utf8')).not.toMatch(/tok|pat\b/);
  });

  it('a new disagreement (exit 3) still counts as a completed check: stamp written, exit 0 for launchd', () => {
    stubs({ report: REPORT_FALSE_GREEN });
    secrets('pat', 'tok');
    const r = run(HUME, env());
    expect(r.code, r.err).toBe(0);
    expect(existsSync(stampFile())).toBe(true);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/1 new disagreement/);
  });

  it('a missing keychain item is a named failure: exit 2, no stamp', () => {
    stubs();
    secrets('', 'tok');
    const r = run(HUME, env());
    expect(r.code).toBe(2);
    expect(existsSync(stampFile())).toBe(false);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/ERROR: keychain item vendor-dashboard-truth-check-pat/);
  });

  it('an infrastructure failure inside the check withholds the stamp and exits non-zero', () => {
    stubs();
    stub('curl', 'exit 22');
    secrets('pat', 'tok');
    const r = run(HUME, env());
    expect(r.code).not.toBe(0);
    expect(existsSync(stampFile())).toBe(false);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/ERROR: truth check failed/);
  });

  it('on any host but the always-on one it declines quietly: exit 0, no stamp', () => {
    stubs();
    secrets('pat', 'tok');
    const r = run(HUME, { ...env(), TRUTH_CHECK_HOST: 'socrates' });
    expect(r.code, r.err).toBe(0);
    expect(existsSync(stampFile())).toBe(false);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/not the always-on host/);
  });
});
