/**
 * ai-fetches.js — count who fetches the AI-tool files (worklist #127, 2026-09-30).
 *
 * Brian asked for evidence, not assumptions, that AI tools use llms.txt,
 * llms-full.txt and the per-page Markdown copies. wrangler.jsonc routes only
 * those paths (and the feed) through the Worker first (`run_worker_first`);
 * every other request is still served straight from static assets. For each
 * counted request this module:
 *
 *   1. names the requester from its User-Agent (GPTBot, ClaudeBot,
 *      PerplexityBot, ... or "browser/other");
 *   2. adds one to a per-day tally in D1 (table ai_fetches, one atomic
 *      UPSERT per fetch, rows older than 90 days pruned). It was KV first,
 *      and a live check on 2026-09-30 recorded 2 of 4 fetches: KV reads are
 *      edge-cached for up to 60 s, so read-modify-write lost increments,
 *      worst exactly when a crawler fetches in bursts;
 *   3. serves the static file unchanged except for an explicit UTF-8 charset
 *      (Cloudflare sends .md as bare text/markdown).
 *
 * /ai-fetches.json serves the last 30 days as aggregate counts (no IPs, no
 * full user agents) for mission-control's card and the weekly vault report.
 *
 * The same file runs on briangreenberg.net, gsysd.com and coffeehouses.org.
 */

/** [pattern, name]; first match wins, so specific agents precede generic ones. */
export const AGENTS = [
  [/GPTBot/i, 'GPTBot'],
  [/OAI-SearchBot/i, 'OAI-SearchBot'],
  [/ChatGPT-User/i, 'ChatGPT-User'],
  [/ClaudeBot/i, 'ClaudeBot'],
  [/Claude-User/i, 'Claude-User'],
  [/Claude-SearchBot/i, 'Claude-SearchBot'],
  [/anthropic-ai/i, 'anthropic-ai'],
  [/PerplexityBot/i, 'PerplexityBot'],
  [/Perplexity-User/i, 'Perplexity-User'],
  [/Google-Extended|Google-CloudVertexBot|GoogleOther/i, 'Google-AI'],
  [/Googlebot/i, 'Googlebot'],
  [/bingbot/i, 'Bingbot'],
  [/Applebot-Extended/i, 'Applebot-Extended'],
  [/Applebot/i, 'Applebot'],
  [/Amazonbot/i, 'Amazonbot'],
  [/Bytespider/i, 'Bytespider'],
  [/CCBot/i, 'CCBot'],
  [/meta-externalagent|meta-externalfetcher|FacebookBot/i, 'Meta'],
  [/DuckAssistBot/i, 'DuckAssistBot'],
  [/MistralAI-User/i, 'MistralAI-User'],
  [/cohere-ai|cohere-training/i, 'Cohere'],
  [/YouBot/i, 'YouBot'],
  [/Diffbot/i, 'Diffbot'],
  [/bot\b|crawler|spider|curl\/|wget\/|python-requests|python-httpx|aiohttp|node-fetch|Go-http-client|axios\//i, 'other-automated'],
];

/** Who asked, from the User-Agent header. @param {string|null} ua */
export function agentOf(ua) {
  const s = String(ua ?? '');
  for (const [re, name] of AGENTS) if (re.test(s)) return name;
  return 'browser/other';
}

/**
 * Which counted file a path is, or null for anything else.
 * @param {string} pathname
 * @param {string[]} feedPaths the site's feed URLs (exact)
 */
export function kindOf(pathname, feedPaths = []) {
  if (pathname === '/llms.txt' || pathname.endsWith('/llms.txt')) return 'llms.txt';
  if (pathname === '/llms-full.txt') return 'llms-full.txt';
  if (pathname.endsWith('.md')) return 'markdown';
  if (feedPaths.includes(pathname)) return 'feed';
  return null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS ai_fetches (
  day TEXT NOT NULL, kind TEXT NOT NULL, agent TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, agent))`;
const RETAIN_DAYS = 90;
let schemaReady = false;

/** Create the table once per isolate (idempotent). @param {D1Database} db */
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(SCHEMA).run();
  schemaReady = true;
}

/** Test hook: forget that the schema exists (a fresh database per test). */
export function resetSchemaFlag() {
  schemaReady = false;
}

/**
 * Add one fetch to the day's tally: a single atomic UPSERT, so concurrent
 * fetches never lose counts. Never throws: counting must not break serving.
 * @param {D1Database} db
 * @param {{kind: string, agent: string, day: string}} hit
 */
export async function countFetch(db, { kind, agent, day }) {
  try {
    await ensureSchema(db);
    await db
      .prepare('INSERT INTO ai_fetches (day, kind, agent, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, kind, agent) DO UPDATE SET n = n + 1')
      .bind(day, kind, agent)
      .run();
  } catch (err) {
    console.error(JSON.stringify({ event: 'ai_fetch_count_failed', detail: String(err?.message ?? err) }));
  }
}

/**
 * The last `days` days as {site, generatedAt, windowDays, totals, days: [{day, counts}]};
 * also prunes rows past the retention window.
 * @param {D1Database} db
 * @param {{site: string, days?: number, now?: Date}} opts
 */
export async function stats(db, { site, days = 30, now = new Date() }) {
  await ensureSchema(db);
  const dayOf = (i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
  // Keep exactly RETAIN_DAYS day buckets, today included (Copilot, vendor-dashboard #156).
  await db.prepare('DELETE FROM ai_fetches WHERE day < ?').bind(dayOf(RETAIN_DAYS - 1)).run();
  const { results = [] } = await db.prepare('SELECT day, kind, agent, n FROM ai_fetches WHERE day >= ? ORDER BY day DESC').bind(dayOf(days - 1)).all();
  const byDay = new Map();
  const totals = {};
  for (const { day, kind, agent, n } of results) {
    const counts = byDay.get(day) ?? {};
    counts[kind] = counts[kind] ?? {};
    counts[kind][agent] = n;
    byDay.set(day, counts);
    totals[kind] = totals[kind] ?? {};
    totals[kind][agent] = (totals[kind][agent] ?? 0) + n;
  }
  const out = [];
  for (let i = 0; i < days; i += 1) out.push({ day: dayOf(i), counts: byDay.get(dayOf(i)) ?? {} });
  return { site, generatedAt: now.toISOString(), windowDays: days, totals, days: out };
}

const CHARSET_TYPES = { markdown: 'text/markdown; charset=utf-8', 'llms.txt': 'text/plain; charset=utf-8', 'llms-full.txt': 'text/plain; charset=utf-8' };

/**
 * Serve a counted path: tally it (after the response, via waitUntil), then return
 * the static asset with an explicit UTF-8 charset. Returns null for uncounted paths.
 * @param {Request} request
 * @param {{ASSETS: Fetcher, AI_FETCHES?: D1Database}} env
 * @param {{waitUntil: (p: Promise<unknown>) => void}} ctx
 * @param {{site: string, feedPaths?: string[], now?: () => Date}} opts
 */
export async function handleAiFetch(request, env, ctx, { site, feedPaths = [], now = () => new Date() }) {
  const url = new URL(request.url);
  if (url.pathname === '/ai-fetches.json') {
    if (!env.AI_FETCHES) return new Response('{"error":"not configured"}', { status: 501, headers: { 'Content-Type': 'application/json' } });
    const body = await stats(env.AI_FETCHES, { site, now: now() });
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    });
  }
  const kind = kindOf(url.pathname, feedPaths);
  if (!kind || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  const asset = await env.ASSETS.fetch(request);
  if (asset.ok && env.AI_FETCHES && ctx?.waitUntil) {
    ctx.waitUntil(countFetch(env.AI_FETCHES, { kind, agent: agentOf(request.headers.get('User-Agent')), day: now().toISOString().slice(0, 10) }));
  }
  if (!asset.ok || !CHARSET_TYPES[kind]) return asset;
  const res = new Response(asset.body, asset);
  res.headers.set('Content-Type', CHARSET_TYPES[kind]);
  return res;
}
