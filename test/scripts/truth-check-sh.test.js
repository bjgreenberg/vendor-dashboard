import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync } from 'node:fs';
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
  unreadable: [],
  uncovered: ['Zscaler'],
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

function stubs({ report = REPORT_CLEAN, openIssue = '', openUnreadable = '' } = {}) {
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
  "issue list") if [[ "$*" == *"truth-check-unreadable"* ]]; then printf '%s' "${openUnreadable}"; elif [[ "$*" == *"--json number"* ]]; then printf '%s' "${openIssue}"; else printf ''; fi;;
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
      unreadable: 0,
      uncovered: ['Zscaler'],
    });
    expect(r.out).toMatch(/stamp HTTP 204/);
  });

  it('stamps how many feeds could not be read, and sends null when the report has no list (#340)', () => {
    stubs({ report: { ...REPORT_CLEAN, agreed: 1, unreadable: ['Okta', 'Zoom'] } });
    expect(run(CHECK, { TRUTH_CHECK_TOKEN: 't' }).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'stamp.posted.json'), 'utf8')).unreadable).toBe(2);
    const { unreadable: _drop, ...noList } = REPORT_CLEAN;
    stubs({ report: noList });
    expect(run(CHECK, { TRUTH_CHECK_TOKEN: 't' }).code).toBe(0);
    // never 0 by default: a missing list is "not known" (stated as "not reported"
    // wherever a fresh line prints; hiding is decided by agreed, not by this)
    expect(JSON.parse(readFileSync(join(dir, 'stamp.posted.json'), 'utf8')).unreadable).toBeNull();
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

describe('check.sh — an alert when a vendor stays unreadable (#340, Brian 2026-11-16)', () => {
  // Brian: "There needs to be an alert about a failure." The page keeps a
  // partly-read stamp hidden (his "340 H"), so the alert is a GitHub issue,
  // filed once a vendor has been unreadable for 3 runs in a row (a threshold,
  // not every miss: Discord misses about one run in four), closed when it reads
  // again. The streak lives in TRUTH_CHECK_STATE_DIR; a runner without one
  // (the GitHub backstop) leaves the alert to hume.
  const UNREAD = {
    ...REPORT_CLEAN,
    agreed: 2,
    unreadable: ['Discord'],
    unreadableDetail: [{ vendor: 'Discord', evidence: ['Discord: timeout after 20000 ms'], urls: ['https://discordstatus.com/api/v2/summary.json'] }],
  };
  const calls = () => (existsSync(join(dir, 'gh.calls')) ? readFileSync(join(dir, 'gh.calls'), 'utf8') : '');
  let state;
  beforeEach(() => {
    state = join(dir, 'state');
    mkdirSync(state);
  });

  it('two unreadable runs file nothing; the third files one issue carrying the reason', () => {
    stubs({ report: UNREAD });
    for (const n of [1, 2]) {
      const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(new RegExp(`unreadable streak: Discord ${n}`));
    }
    expect(calls()).not.toMatch(/issue create/);
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    expect(r.code, r.err).toBe(0); // an alert, not a disagreement: never exit 3
    expect(calls()).toMatch(/label create truth-check-unreadable/);
    expect(calls()).toMatch(/issue create .*--label truth-check-unreadable .*--title truth-check unreadable: Discord/);
    expect(readFileSync(join(work, 'unreadable-body.md'), 'utf8')).toMatch(/timeout after 20000 ms/);
  });

  it('an open alert is not filed again while the vendor stays unreadable', () => {
    stubs({ report: UNREAD, openUnreadable: '90\ttruth-check unreadable: Discord' });
    writeFileSync(join(state, 'unreadable-streaks.json'), JSON.stringify({ Discord: 7 }));
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    expect(r.code, r.err).toBe(0);
    expect(calls()).not.toMatch(/issue create/);
    expect(calls()).not.toMatch(/issue close/);
  });

  it('a vendor that reads again resets its streak and closes its open alert', () => {
    stubs({ report: REPORT_CLEAN, openUnreadable: '90\ttruth-check unreadable: Discord' });
    writeFileSync(join(state, 'unreadable-streaks.json'), JSON.stringify({ Discord: 5 }));
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    expect(r.code, r.err).toBe(0);
    expect(calls()).toMatch(/issue comment 90/);
    expect(calls()).toMatch(/issue close 90/);
    expect(JSON.parse(readFileSync(join(state, 'unreadable-streaks.json'), 'utf8'))).toEqual({});
  });

  it('an alert closes only when the feed was READ: not when the vendor is uncovered or off the board (Codex on #197)', () => {
    for (const report of [{ ...REPORT_CLEAN, uncovered: ['Discord'] }, { ...REPORT_CLEAN, notOnBoard: ['Discord'] }]) {
      stubs({ report, openUnreadable: '90\ttruth-check unreadable: Discord' });
      writeFileSync(join(state, 'unreadable-streaks.json'), JSON.stringify({ Discord: 5 }));
      const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
      expect(r.code, r.err).toBe(0);
      expect(calls()).not.toMatch(/issue close 90/);
    }
  });

  it('asks gh for every open alert, not its default first 30 (Codex on #197)', () => {
    stubs({ report: UNREAD });
    run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    expect(calls()).toMatch(/issue list .*--label truth-check-unreadable .*--limit 200/);
  });

  it('one readable run between misses resets the count', () => {
    stubs({ report: UNREAD });
    run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    stubs({ report: REPORT_CLEAN });
    run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    stubs({ report: UNREAD });
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't', TRUTH_CHECK_STATE_DIR: state });
    expect(r.out).toMatch(/unreadable streak: Discord 1/);
    expect(calls()).not.toMatch(/issue create/);
  });

  it('without a state dir it files no alert and says so', () => {
    stubs({ report: UNREAD });
    const r = run(CHECK, { TRUTH_CHECK_TOKEN: 't' });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no TRUTH_CHECK_STATE_DIR/);
    expect(calls()).not.toMatch(/truth-check-unreadable/);
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

  it('hands check.sh its state dir, so the unreadable-feed streak survives between runs (#340)', () => {
    stubs({ report: { ...REPORT_CLEAN, unreadable: ['Discord'], unreadableDetail: [] } });
    secrets('pat', 'tok');
    expect(run(HUME, env()).code).toBe(0);
    const streaks = join(dir, 'home', '.local', 'state', 'vendor-dashboard-truth-check', 'unreadable-streaks.json');
    expect(JSON.parse(readFileSync(streaks, 'utf8'))).toEqual({ Discord: 1 });
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

  // A log shipper (vlagent, #200) tails this file by inode and offset. A
  // rewrite in place (`tail -c N > tmp && mv tmp LOG`) gives it a new inode
  // full of lines it has already shipped, and it ships them again. Rotation
  // must RENAME the file: the old inode lives on as LOG.1, untouched, and the
  // log starts empty.
  it('an over-cap log is renamed to .1 (same inode, content intact) and a fresh 600 log starts', () => {
    stubs();
    secrets('pat', 'tok');
    const history = 'HISTORY line\n'.repeat(Math.ceil((1024 * 1024) / 13) + 10);
    writeFileSync(logFile(), history);
    chmodSync(logFile(), 0o600);
    const inode = statSync(logFile()).ino;
    const r = run(HUME, { ...env(), TRUTH_CHECK_HOST: 'socrates' });
    expect(r.code, r.err).toBe(0);
    const rotated = `${logFile()}.1`;
    expect(statSync(rotated).ino).toBe(inode);
    expect(readFileSync(rotated, 'utf8')).toBe(history);
    expect(statSync(rotated).mode & 0o777).toBe(0o600);
    expect(statSync(logFile()).ino).not.toBe(inode);
    expect(readFileSync(logFile(), 'utf8')).not.toMatch(/HISTORY/);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/not the always-on host/);
    expect(statSync(logFile()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${logFile()}.tmp`)).toBe(false);
  });

  it('a log under the cap is appended to in place, never rotated', () => {
    stubs();
    secrets('pat', 'tok');
    writeFileSync(logFile(), 'earlier run\n');
    const inode = statSync(logFile()).ino;
    const r = run(HUME, { ...env(), TRUTH_CHECK_HOST: 'socrates' });
    expect(r.code, r.err).toBe(0);
    expect(statSync(logFile()).ino).toBe(inode);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/^earlier run\n.*not the always-on host/s);
    expect(existsSync(`${logFile()}.1`)).toBe(false);
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
