// The shared counter's unit tests (identical to the three sites' worker/ai-fetches.test.mjs, run here under vitest; worklist #127).
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { agentOf, kindOf, countFetch, stats, handleAiFetch, resetSchemaFlag } from '../../src/worker/ai-fetches.js';

/**
 * A D1Database stand-in over node:sqlite: prepare().bind().run()/all(), the
 * subset the module uses. Real SQL, so the UPSERT semantics are the real ones.
 */
function memD1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async run() { db.prepare(sql).run(...args); return { success: true }; },
    async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
  });
  return { db, prepare: (sql) => wrap(sql) };
}
const rows = (d) => d.db.prepare('SELECT day, kind, agent, n FROM ai_fetches ORDER BY kind, agent').all().map((r) => ({ ...r }));
const assets = (body = 'hello', status = 200, type = 'text/markdown') => ({
  async fetch() { return new Response(body, { status, headers: { 'Content-Type': type } }); },
});

beforeEach(() => resetSchemaFlag());

test('names AI crawlers specifically and everything else broadly', () => {
  assert.equal(agentOf('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)'), 'GPTBot');
  assert.equal(agentOf('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'), 'ClaudeBot');
  assert.equal(agentOf('Mozilla/5.0 (compatible; PerplexityBot/1.0)'), 'PerplexityBot');
  assert.equal(agentOf('Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML, like Gecko) Version/18 Safari/605 (Applebot/0.1)'), 'Applebot');
  assert.equal(agentOf('curl/8.7.1'), 'other-automated');
  assert.equal(agentOf('Mozilla/5.0 (iPhone) Safari/604.1'), 'browser/other');
  assert.equal(agentOf(null), 'browser/other');
});

test('counts only the AI-tool files and the feed', () => {
  assert.equal(kindOf('/llms.txt'), 'llms.txt');
  assert.equal(kindOf('/service-status/llms.txt'), 'llms.txt');
  assert.equal(kindOf('/llms-full.txt'), 'llms-full.txt');
  assert.equal(kindOf('/about/index.md'), 'markdown');
  assert.equal(kindOf('/about.html.md'), 'markdown');
  assert.equal(kindOf('/feed/index.xml', ['/feed/index.xml']), 'feed');
  assert.equal(kindOf('/about/'), null);
  assert.equal(kindOf('/assets/site.css'), null);
});

test('tallies per day, per file kind, per agent', async () => {
  const d1 = memD1();
  await countFetch(d1, { kind: 'markdown', agent: 'GPTBot', day: '2026-09-30' });
  await countFetch(d1, { kind: 'markdown', agent: 'GPTBot', day: '2026-09-30' });
  await countFetch(d1, { kind: 'llms.txt', agent: 'ClaudeBot', day: '2026-09-30' });
  assert.deepEqual(rows(d1), [
    { day: '2026-09-30', kind: 'llms.txt', agent: 'ClaudeBot', n: 1 },
    { day: '2026-09-30', kind: 'markdown', agent: 'GPTBot', n: 2 },
  ]);
});

test('a burst of concurrent fetches loses nothing (the KV version recorded 2 of 4 live)', async () => {
  const d1 = memD1();
  await Promise.all(Array.from({ length: 100 }, () => countFetch(d1, { kind: 'markdown', agent: 'GPTBot', day: '2026-09-30' })));
  assert.equal(rows(d1)[0].n, 100);
});

test('a KV failure never breaks serving', async () => {
  const broken = { prepare() { throw new Error('d1 down'); } };
  await assert.doesNotReject(countFetch(broken, { kind: 'markdown', agent: 'x', day: '2026-09-30' }));
});

test('stats sums the window into totals and prunes past 90 days', async () => {
  const d1 = memD1();
  await countFetch(d1, { kind: 'markdown', agent: 'GPTBot', day: '2026-09-30' });
  await countFetch(d1, { kind: 'markdown', agent: 'GPTBot', day: '2026-09-29' });
  await countFetch(d1, { kind: 'markdown', agent: 'GPTBot', day: '2026-01-01' });
  const s = await stats(d1, { site: 'x', days: 3, now: new Date('2026-09-30T12:00:00Z') });
  assert.equal(s.totals.markdown.GPTBot, 2);
  assert.equal(s.days.length, 3);
  assert.deepEqual(s.days[1].counts, { markdown: { GPTBot: 1 } });
  assert.equal(rows(d1).some((r) => r.day === '2026-01-01'), false);
});

test('serves a counted file with a UTF-8 charset and tallies it after the response', async () => {
  const d1 = memD1();
  const pending = [];
  const res = await handleAiFetch(
    new Request('https://x.example/about/index.md', { headers: { 'User-Agent': 'GPTBot/1.2' } }),
    { ASSETS: assets(), AI_FETCHES: d1 },
    { waitUntil: (p) => pending.push(p) },
    { site: 'x', now: () => new Date('2026-09-30T12:00:00Z') },
  );
  assert.equal(res.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(await res.text(), 'hello');
  await Promise.all(pending);
  assert.deepEqual(rows(d1), [{ day: '2026-09-30', kind: 'markdown', agent: 'GPTBot', n: 1 }]);
});

test('a 404 is passed through and not counted; uncounted paths return null', async () => {
  const d1 = memD1();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const miss = await handleAiFetch(new Request('https://x.example/nope/index.md'), { ASSETS: assets('no', 404), AI_FETCHES: d1 }, ctx, { site: 'x' });
  assert.equal(miss.status, 404);
  assert.equal(pending.length, 0);
  assert.equal(await handleAiFetch(new Request('https://x.example/about/'), { ASSETS: assets(), AI_FETCHES: d1 }, ctx, { site: 'x' }), null);
});

test('/ai-fetches.json reports aggregate counts only', async () => {
  const d1 = memD1();
  await countFetch(d1, { kind: 'markdown', agent: 'GPTBot', day: '2026-09-30' });
  const res = await handleAiFetch(new Request('https://x.example/ai-fetches.json'), { ASSETS: assets(), AI_FETCHES: d1 }, {}, { site: 'x', now: () => new Date('2026-09-30T12:00:00Z') });
  const body = await res.json();
  assert.equal(body.site, 'x');
  assert.equal(body.totals.markdown.GPTBot, 1);
  assert.doesNotMatch(JSON.stringify(body), /Mozilla|\d+\.\d+\.\d+\.\d+/);
});
