import { describe, it, expect, beforeEach } from 'vitest';
import { makeD1 } from '../helpers/d1.js';
import worker from '../../src/worker/index.js';
import { resetSchemaFlag } from '../../src/worker/ai-fetches.js';

// worklist #127 (2026-09-30): who fetches /service-status/llms.txt and
// /service-status/index.md. Same counter as the three sites
// (src/worker/ai-fetches.js), backed by the board's own D1 (migration 0004).
const env = (db) => ({ DB: db, BASE_PATH: '/service-status' });
const get = (db, path, ua, method = 'GET') => {
  const pending = [];
  return worker
    .fetch(new Request(`https://briangreenberg.net/service-status${path}`, { method, headers: ua ? { 'User-Agent': ua } : {} }), env(db), { waitUntil: (p) => pending.push(p) })
    .then(async (res) => { await Promise.all(pending); return res; });
};

describe('AI-fetch counting on the dashboard', () => {
  beforeEach(() => resetSchemaFlag());

  it('counts llms.txt and index.md fetches by crawler', async () => {
    const db = makeD1();
    await get(db, '/llms.txt', 'Mozilla/5.0 (compatible; ClaudeBot/1.0)');
    await get(db, '/index.md', 'GPTBot/1.2');
    await get(db, '/index.md', 'GPTBot/1.2');
    const rows = db.sqlite.prepare('SELECT kind, agent, n FROM ai_fetches ORDER BY kind').all().map((r) => ({ ...r }));
    expect(rows).toEqual([
      { kind: 'llms.txt', agent: 'ClaudeBot', n: 1 },
      { kind: 'markdown', agent: 'GPTBot', n: 2 },
    ]);
  });

  it('does not count the HTML board or the JSON API', async () => {
    const db = makeD1();
    await get(db, '/llms.txt', 'GPTBot/1.2'); // creates the table
    await get(db, '/api/status', 'GPTBot/1.2');
    const n = db.sqlite.prepare('SELECT SUM(n) AS n FROM ai_fetches').get().n;
    expect(n).toBe(1);
  });

  it('counts GET and HEAD only, never other methods (Copilot, #156)', async () => {
    const db = makeD1();
    await get(db, '/llms.txt', 'GPTBot/1.2');
    await get(db, '/llms.txt', 'GPTBot/1.2', 'POST');
    await get(db, '/llms.txt', 'GPTBot/1.2', 'OPTIONS');
    expect(db.sqlite.prepare('SELECT SUM(n) AS n FROM ai_fetches').get().n).toBe(1);
  });

  it('/ai-fetches.json reports the 30-day aggregates', async () => {
    const db = makeD1();
    await get(db, '/index.md', 'PerplexityBot/1.0');
    const res = await get(db, '/ai-fetches.json');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.site).toBe('briangreenberg.net/service-status');
    expect(body.totals.markdown.PerplexityBot).toBe(1);
  });
});
