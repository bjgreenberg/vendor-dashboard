import { describe, it, expect } from 'vitest';
import { makeD1 } from '../helpers/d1.js';
import worker from '../../src/worker/index.js';
import { writeTruthCheck, readTruthCheck } from '../../src/worker/storage.js';
import { renderDashboard } from '../../src/worker/render.js';

// The stamp closes the loop the truth-check workflow opens: verification is
// visible on the board, and a missing or stale stamp is itself the alarm.
const stamp = (over = {}) => ({
  checkedAt: '2026-09-05T06:00:00.000Z',
  covered: 36,
  total: 49,
  agreed: 36,
  disagreements: 0,
  falseGreen: [],
  ...over,
});

const post = (env, body, token) =>
  worker.fetch(
    new Request('https://w.example/api/truth-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );

describe('storage — truth_check row', () => {
  it('round-trips and upserts the single row', async () => {
    const db = makeD1();
    expect(await readTruthCheck(db)).toBeNull();
    await writeTruthCheck(db, stamp({ disagreements: 2, falseGreen: ['Google', 'Zoom'] }));
    const got = await readTruthCheck(db);
    expect(got).toMatchObject({ checkedAt: '2026-09-05T06:00:00.000Z', covered: 36, total: 49, agreed: 36, disagreements: 2, falseGreen: ['Google', 'Zoom'] });
    await writeTruthCheck(db, stamp({ checkedAt: '2026-09-05T08:00:00.000Z' }));
    expect((await readTruthCheck(db)).checkedAt).toBe('2026-09-05T08:00:00.000Z');
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM truth_check').get().n).toBe(1);
  });
});

describe('POST /api/truth-check — the workflow writes the stamp', () => {
  it('is disabled (501) until the deployment configures a token — forks need nothing', async () => {
    const res = await post({ DB: makeD1() }, stamp(), 'anything');
    expect(res.status).toBe(501);
  });
  it('rejects a missing or wrong bearer token (401) and writes nothing', async () => {
    const db = makeD1();
    const env = { DB: db, TRUTH_CHECK_TOKEN: 'correct-horse' };
    expect((await post(env, stamp())).status).toBe(401);
    expect((await post(env, stamp(), 'wrong')).status).toBe(401);
    expect((await post(env, stamp(), 'correct-horse-battery')).status).toBe(401);
    expect(await readTruthCheck(db)).toBeNull();
  });
  it('rejects a malformed body (400): the workflow is a trust boundary too', async () => {
    const env = { DB: makeD1(), TRUTH_CHECK_TOKEN: 't' };
    expect((await post(env, '{not json', 't')).status).toBe(400);
    expect((await post(env, stamp({ covered: -1 }), 't')).status).toBe(400);
    expect((await post(env, stamp({ checkedAt: 'yesterday' }), 't')).status).toBe(400);
    expect((await post(env, stamp({ falseGreen: 'Google' }), 't')).status).toBe(400);
    expect((await post(env, stamp({ falseGreen: ['x'.repeat(300)] }), 't')).status).toBe(400);
  });
  it('stores a good stamp (204) and /api/status carries it', async () => {
    const db = makeD1();
    const env = { DB: db, TRUTH_CHECK_TOKEN: 't' };
    const res = await post(env, stamp({ disagreements: 1, falseGreen: ['Google'] }), 't');
    expect(res.status).toBe(204);
    const api = await worker.fetch(new Request('https://w.example/api/status'), env);
    const body = await api.json();
    expect(body.truthCheck).toMatchObject({ covered: 36, total: 49, disagreements: 1, falseGreen: ['Google'] });
  });
  it('only POST is accepted on the path', async () => {
    const env = { DB: makeD1(), TRUTH_CHECK_TOKEN: 't' };
    const res = await worker.fetch(new Request('https://w.example/api/truth-check'), env);
    expect(res.status).toBe(405);
  });
});

describe('renderDashboard — the truth-check stamp', () => {
  const at = new Date('2026-09-05T07:00:00.000Z'); // one hour after the stamp
  const render = (truthCheck, now = at) => renderDashboard({ records: [], meta: null, truthCheck, now: () => now });

  it('says so when the board has never been truth-checked', () => {
    expect(render(null)).toContain('Not yet truth-checked');
  });
  it('a fresh stamp with no disagreements reads as verified', () => {
    const html = render(stamp());
    expect(html).toMatch(/Truth-checked <time[^>]*datetime="2026-09-05T06:00:00.000Z"[^>]*>[^<]+<\/time> against 36 of 49 vendors/);
    expect(html).toContain('no disagreements');
    expect(html).not.toContain('overdue');
  });
  it('disagreements are counted and named', () => {
    const html = render(stamp({ disagreements: 2, falseGreen: ['Google', 'Zoom'] }));
    expect(html).toContain('2 disagreements');
    expect(html).toContain('Google, Zoom');
    expect(html).toContain('vs-truth--disagree');
  });
  it('a stamp older than three hours is the alarm: overdue, styled stale', () => {
    const html = render(stamp(), new Date('2026-09-05T09:00:01.000Z'));
    expect(html).toContain('Truth check overdue');
    expect(html).toContain('vs-stale');
  });
  it('vendor names in the stamp are escaped like every other vendor string', () => {
    const html = render(stamp({ disagreements: 1, falseGreen: ['<b>x</b>'] }));
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
