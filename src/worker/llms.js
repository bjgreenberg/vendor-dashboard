/**
 * Machine-readable views of the board for AI tools (worklist #127, 2026-09-30).
 *
 * - /service-status/llms.txt — an llms.txt for this subpath (llmstxt.org lets
 *   one sit at any subpath, covering the pages under it): what the board is,
 *   how it decides, its endpoints, and every vendor with its live state.
 * - /service-status/index.md — the spec's clean-Markdown copy of the page.
 *
 * Both are rendered from the same snapshot as the HTML page, so the vendor
 * list, counts and states cannot drift from the board. Vendor strings are
 * third-party text: flattened to one line, pipes escaped in the table, source
 * URLs passed through the page's own safeUrl (http/https only). llms.txt is
 * kept pure ASCII like the site's own; the Markdown copy keeps Unicode.
 */
import { safeUrl } from './render.js';

const SITE_NAME = 'briangreenberg.net';
const REPO_URL = 'https://github.com/bjgreenberg/vendor-dashboard';

/** One line, trimmed, capped. @param {unknown} s @param {number} [max] */
const line = (s, max = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

/** ASCII-only: decompose accents, then drop anything still outside ASCII. @param {string} s */
const ascii = (s) => s.normalize('NFKD').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/·/g, '-').replace(/[^\x20-\x7e\n]/g, '');

/** A Markdown table cell: one line, pipes escaped. @param {unknown} s */
const cell = (s) => line(s, 300).replace(/\|/g, '\\|');

/**
 * @typedef {{records?: any[], meta?: any, truthCheck?: any, origin: string, base: string}} ViewInput
 */

/** Shared facts both views state. @param {ViewInput} v */
function facts({ records = [], meta, truthCheck, origin, base }) {
  const abs = (p) => `${origin}${base}${p}`;
  const impacted = records.filter((r) => !['operational', 'unknown'].includes(r.severity)).length;
  const unknown = records.filter((r) => r.severity === 'unknown').length;
  const truth = truthCheck?.checkedAt
    ? `Double-checked ${truthCheck.checkedAt} against ${truthCheck.covered} of ${truthCheck.total} vendors' own status feeds; ${truthCheck.disagreements} disagreement(s).`
    : 'Not yet double-checked against the vendors\' own feeds.';
  return { abs, impacted, unknown, truth, snapshot: meta?.checked_at ?? 'none yet', count: records.length };
}

/**
 * /service-status/llms.txt
 * @param {ViewInput} v
 * @returns {string}
 */
export function renderLlmsTxt(v) {
  const f = facts(v);
  const out = [
    `# Service Status - ${SITE_NAME}`,
    '',
    `> Live operational status for ${f.count} SaaS and cloud vendors, read directly from each vendor's own status page every 15 minutes, from a US vantage point. Part of ${SITE_NAME}.`,
    '',
    `Snapshot: ${f.snapshot}. ${f.impacted} impacted, ${f.unknown} unknown.`,
    f.truth,
    '',
    '## How it works',
    '',
    "- Each vendor's own public status page or API is polled every 15 minutes; nothing comes from a third-party aggregator.",
    '- A check that fails reads "unknown", never green.',
    '- Where a vendor publishes per-region status, the row reflects its US regions; other regions inform but do not set the state.',
    "- A separate truth check re-reads every vendor's own feed by a different code path each hour and flags any vendor the board shows green while the vendor says otherwise.",
    '',
    '## Machine-readable endpoints',
    '',
    `- ${f.abs('/api/status')} - JSON: every vendor's record (severity, incident, description, components, source URL, checked time) plus the truth-check stamp`,
    `- ${f.abs('/health')} - JSON freshness probe; 503 when the snapshot is stale`,
    `- ${f.abs('/index.md')} - this board as clean Markdown`,
    `- ${f.abs('')} - the board itself (HTML)`,
    `- ${REPO_URL} - source code (open source)`,
    '',
    `## Vendors (${f.count})`,
    '',
    ...(v.records ?? []).map((r) => {
      const src = safeUrl(r.sourceUrl);
      const incident = r.incidentName ? ` - ${line(r.incidentName, 120)}` : '';
      return `- ${line(r.vendor, 80)}: ${line(r.severity, 20)}${incident}${src ? ` (${src})` : ''}`;
    }),
    '',
  ];
  return ascii(out.join('\n'));
}

/**
 * /service-status/index.md
 * @param {ViewInput} v
 * @returns {string}
 */
export function renderMarkdown(v) {
  const f = facts(v);
  const rows = (v.records ?? []).map((r) => {
    const detail = [r.incidentName, r.description].filter(Boolean).map((x) => line(x, 200)).join(': ');
    return `| ${cell(r.vendor)} | ${cell(r.severity)} | ${cell(detail)} | ${safeUrl(r.sourceUrl) || ''} |`;
  });
  return [
    '# Service Status',
    '',
    `Live operational status for ${f.count} SaaS and cloud vendors on ${SITE_NAME}, read from each vendor's own status page every 15 minutes (US vantage point). A failed check reads "unknown", never green.`,
    '',
    `- Snapshot: ${f.snapshot} (${f.impacted} impacted, ${f.unknown} unknown)`,
    `- ${f.truth}`,
    `- HTML: ${f.abs('')} - JSON: ${f.abs('/api/status')} - guide for AI tools: ${f.abs('/llms.txt')}`,
    '',
    '| Vendor | Status | Detail | Status page |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
