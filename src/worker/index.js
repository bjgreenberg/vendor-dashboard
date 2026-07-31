/**
 * Cloudflare Worker entry point.
 *
 * Thin by design: this file wires Cloudflare bindings to the runtime-agnostic
 * engine and does no status logic of its own. Everything that decides whether a
 * vendor is healthy lives in src/engine/ and is unit-tested without a network
 * or a Worker runtime.
 */

import { collect } from '../engine/collect.js';
import { writeRun, readSnapshot } from './storage.js';
import { renderDashboard } from './render.js';
import vendorConfig from '../../config/vendors.example.json';

/**
 * Scheduled collection.
 *
 * Deliberately lets a thrown error escape: a failed run is recorded as a failed
 * Cron invocation (visible in observability and the Cron "Past Events" table)
 * and the previous snapshot is left intact. Swallowing the error would leave a
 * stale board looking freshly-verified — the failure mode this whole rewrite
 * exists to eliminate.
 *
 * @param {ScheduledController} controller
 * @param {{DB: D1Database}} env
 */
async function scheduled(controller, env) {
  const started = Date.now();
  const run = await collect(vendorConfig, { fetchFn: fetch.bind(globalThis) });

  await writeRun(env.DB, run);

  // Structured, one event per line, machine-parseable. No vendor content is
  // logged beyond names and severities.
  console.log(
    JSON.stringify({
      event: 'collection_complete',
      checked_at: run.checkedAt,
      total: run.total,
      impacted: run.impacted,
      unknown: run.unknown,
      duration_ms: Date.now() - started,
    }),
  );

  // Surface config drift and staleness rather than letting it accumulate silently.
  for (const warning of run.warnings) {
    console.warn(JSON.stringify({ event: 'collection_warning', detail: warning }));
  }
}

/**
 * HTTP handler: the dashboard plus a JSON endpoint.
 *
 * @param {Request} request
 * @param {{DB: D1Database, BASE_PATH?: string}} env
 */
async function handleFetch(request, env) {
  const url = new URL(request.url);
  const base = env.BASE_PATH ?? '';
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;

  if (path === '/health') {
    return json({ ok: true });
  }

  const { records, meta } = await readSnapshot(env.DB);

  if (path === '/api/status') {
    return json({ meta, records }, { 'Cache-Control': 'public, max-age=60' });
  }

  if (path === '/' || path === '/index.html') {
    // Per-response nonce gates the single inline script, so the CSP can forbid
    // everything else outright rather than allowing 'unsafe-inline' scripts.
    const nonce = crypto.randomUUID().replace(/-/g, '');
    return new Response(renderDashboard({ records, meta, basePath: base, nonce, host: url.hostname }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        // Vendor incident text is attacker-influenced third-party content
        // (audit finding M4). The renderer escapes on output; CSP is the
        // second line of defence.
        'Content-Security-Policy':
          // 'self' is required for the site's own /assets/site.css and
          // /assets/js/theme.js, which this page reuses so it matches the site
          // and shares its appearance preference. Everything else stays denied,
          // and the inline script is nonce-gated rather than 'unsafe-inline'.
          `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    });
  }

  return new Response('Not found', { status: 404 });
}

/** @param {any} body @param {Record<string,string>} [headers] */
function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export default {
  scheduled,
  fetch: handleFetch,
};
