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
import { safeUrl, STALE_AFTER_MS, TRUTH_STALE_AFTER_MS } from './render.js';

const SITE_NAME = 'briangreenberg.net';
const REPO_URL = 'https://github.com/bjgreenberg/vendor-dashboard';

/** One line, trimmed, capped. @param {unknown} s @param {number} [max] */
const line = (s, max = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

/** ASCII-only: CANONICAL decomposition (NFD, not NFKD: compatibility mapping would turn full-width ＜ ！ ［ into the < ! [ that md() already escaped — Copilot, PR #154), then drop anything still outside ASCII. @param {string} s */
const ascii = (s) => s.normalize('NFD').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/·/g, '-').replace(/[^\x20-\x7e\n]/g, '');

/**
 * Neutralise third-party text for Markdown: backslashes first (so an input
 * "a\\|b" cannot leave its pipe unescaped), then HTML metacharacters (so a
 * permissive renderer never sees vendor markup), then link/image brackets and
 * backticks, then table pipes.
 * @param {unknown} s @param {number} [max]
 */
const md = (s, max = 300) =>
  line(s, max)
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Inline links/images and code spans (Copilot, PR #154): "![x](https://tracker)"
    // must stay text, never become an image a renderer fetches.
    .replace(/[[\]`]/g, (c) => `\\${c}`)
    .replace(/\|/g, '\\|');

/**
 * @typedef {{records?: any[], meta?: any, truthCheck?: any, origin: string, base: string, now?: () => Date}} ViewInput
 */

/** Shared facts both views state. @param {ViewInput} v */
function facts({ records = [], meta, truthCheck, origin, base, now = () => new Date() }) {
  const abs = (p) => `${origin}${base}${p}`;
  const impacted = records.filter((r) => !['operational', 'unknown'].includes(r.severity)).length;
  const unknown = records.filter((r) => r.severity === 'unknown').length;
  const t = now().getTime();
  // The same three alarms the HTML board raises (Copilot review, PR #154): an
  // empty board, a stale snapshot, an overdue truth check. A machine reader
  // must never get an unqualified "live" / "double-checked" from dead data.
  const snapAt = meta?.checked_at ? Date.parse(meta.checked_at) : NaN;
  const warnings = [];
  if (records.length === 0) warnings.push('WARNING: no status data has been collected yet; nothing below is current.');
  else if (Number.isNaN(snapAt) || t - snapAt > STALE_AFTER_MS)
    warnings.push(`WARNING: this snapshot is stale (taken ${meta?.checked_at ?? 'at an unknown time'}); collection has stopped, so states below may be out of date.`);
  const truthAt = truthCheck?.checkedAt ? Date.parse(truthCheck.checkedAt) : NaN;
  let truth;
  if (!truthCheck?.checkedAt) truth = "Not yet double-checked against the vendors' own feeds.";
  else if (Number.isNaN(truthAt) || t - truthAt > TRUTH_STALE_AFTER_MS)
    truth = `Truth check OVERDUE: last double-checked ${truthCheck.checkedAt}; treat the states below as unverified.`;
  else
    truth = `Double-checked ${truthCheck.checkedAt} against ${truthCheck.covered} of ${truthCheck.total} vendors' own status feeds; ${truthCheck.disagreements} disagreement(s).`;
  return { abs, impacted, unknown, truth, warnings, snapshot: meta?.checked_at ?? 'none yet', count: records.length };
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
    ...f.warnings,
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
      const incident = r.incidentName ? ` - ${md(r.incidentName, 120)}` : '';
      return `- ${md(r.vendor, 80)}: ${md(r.severity, 20)}${incident}${src ? ` (${src})` : ''}`;
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
    const detail = [r.incidentName, r.description].filter(Boolean).map((x) => line(x, 200)).join(': '); // md() below escapes
    return `| ${md(r.vendor)} | ${md(r.severity)} | ${md(detail)} | ${safeUrl(r.sourceUrl) || ''} |`;
  });
  return [
    '# Service Status',
    '',
    `Live operational status for ${f.count} SaaS and cloud vendors on ${SITE_NAME}, read from each vendor's own status page every 15 minutes (US vantage point). A failed check reads "unknown", never green.`,
    '',
    ...f.warnings.map((w) => `> **${w}**\n`),
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
