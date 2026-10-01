import { describe, it, expect } from 'vitest';
import { makeD1 } from '../helpers/d1.js';
import worker from '../../src/worker/index.js';
import { renderLlmsTxt, renderMarkdown } from '../../src/worker/llms.js';
import { renderDashboard } from '../../src/worker/render.js';

// worklist #127 (2026-09-30): the dashboard gets its own /service-status/llms.txt
// (llmstxt.org allows one at any subpath, covering the pages under it) and the
// spec's clean-Markdown copy of the page at /service-status/index.md. Both are
// generated from the live snapshot so the vendor list and counts cannot drift.
const records = [
  { vendor: 'Cloudflare', service: 'Cloudflare', severity: 'degraded', incidentName: 'Workers build delays', description: 'A fix is being monitored.', sourceUrl: 'https://www.cloudflarestatus.com', checkedAt: '2026-09-30T22:00:00Z' },
  { vendor: 'GitHub', service: 'GitHub', severity: 'operational', incidentName: '', description: 'All systems operational.', sourceUrl: 'https://www.githubstatus.com', checkedAt: '2026-09-30T22:00:00Z' },
  { vendor: 'Weird | Vendoré', service: 'x', severity: 'unknown', incidentName: '', description: 'line one\nline | two', sourceUrl: 'javascript:alert(1)', checkedAt: '2026-09-30T22:00:00Z' },
];
const meta = { checked_at: '2026-09-30T22:01:00Z', total: 3, impacted: 1, unknown: 1 };
const truthCheck = { checkedAt: '2026-09-30T22:11:00Z', covered: 3, total: 3, agreed: 3, disagreements: 0, falseGreen: [], uncovered: [] };
const NOW = () => new Date('2026-09-30T22:20:00Z'); // snapshot 19 min old, truth check 9 min old
const opts = { records, meta, truthCheck, origin: 'https://briangreenberg.net', base: '/service-status', now: NOW };

describe('renderLlmsTxt — /service-status/llms.txt', () => {
  const txt = renderLlmsTxt(opts);
  it('follows the llms.txt shape: H1, blockquote summary, then sections', () => {
    expect(txt).toMatch(/^# Service Status - briangreenberg\.net\n\n> .+\n/);
    expect(txt).toMatch(/\n## How it works\n/);
    expect(txt).toMatch(/\n## Machine-readable endpoints\n/);
    expect(txt).toMatch(/\n## Vendors \(3\)\n/);
  });
  it('is pure ASCII, like the site’s own llms.txt', () => {
    expect([...txt].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
  it('names every vendor with its live state and its own status page', () => {
    expect(txt).toContain('- Cloudflare: degraded - Workers build delays (https://www.cloudflarestatus.com/)');
    expect(txt).toContain('- GitHub: operational (https://www.githubstatus.com/)');
  });
  it('never emits an unsafe source URL', () => {
    expect(txt).not.toContain('javascript:');
  });
  it('links the JSON API, health probe, Markdown copy and the board, absolute', () => {
    for (const p of ['/service-status/api/status', '/service-status/health', '/service-status/index.md', '/service-status'])
      expect(txt).toContain(`https://briangreenberg.net${p}`);
  });
  it('states when the snapshot and the truth check were taken', () => {
    expect(txt).toContain('Snapshot: 2026-09-30T22:01:00Z');
    expect(txt).toContain('Double-checked 2026-09-30T22:11:00Z against 3 of 3 vendors');
  });
});

describe('renderMarkdown — /service-status/index.md', () => {
  const md = renderMarkdown(opts);
  it('is a clean Markdown copy: title, summary, a status table', () => {
    expect(md).toMatch(/^# Service Status\n/);
    expect(md).toContain('| Vendor | Status | Detail | Status page |');
    expect(md).toContain('| Cloudflare | degraded | Workers build delays: A fix is being monitored. | https://www.cloudflarestatus.com/ |');
  });
  it('escapes pipes and newlines so a vendor string cannot break the table', () => {
    expect(md).toContain('Weird \\| Vendor');
    expect(md).toContain('line one line \\| two');
    expect(md).not.toContain('javascript:');
  });
});

describe('the Worker serves both, with the right types', () => {
  const env = () => ({ DB: makeD1(), BASE_PATH: '/service-status' });
  it('GET /service-status/llms.txt is text/plain', async () => {
    const res = await worker.fetch(new Request('https://briangreenberg.net/service-status/llms.txt'), env());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toMatch(/^# Service Status/);
  });
  it('GET /service-status/index.md is text/markdown', async () => {
    const res = await worker.fetch(new Request('https://briangreenberg.net/service-status/index.md'), env());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });
});

describe('the HTML board points AI tools at its Markdown copy', () => {
  it('carries <link rel="alternate" type="text/markdown"> to index.md', () => {
    expect(renderDashboard({})).toContain('<link rel="alternate" type="text/markdown" href="https://briangreenberg.net/service-status/index.md"');
  });
});

describe('untrusted vendor text is neutralised for Markdown (Copilot + CodeQL, PR #154)', () => {
  const nasty = [{ vendor: 'a\\|b <img src=x onerror=alert(1)> & c', service: 'x', severity: 'degraded', incidentName: '<b>bold</b>', description: 'd', sourceUrl: 'https://x.example', checkedAt: '' }];
  const md = renderMarkdown({ ...opts, records: nasty });
  const txt = renderLlmsTxt({ ...opts, records: nasty });
  it('escapes a backslash before a pipe, so the pipe stays escaped', () => {
    expect(md).toContain('a\\\\\\|b');
  });
  it('encodes HTML so no vendor markup reaches a renderer', () => {
    for (const out of [md, txt]) {
      expect(out).not.toContain('<img');
      expect(out).not.toContain('<b>');
    }
    expect(md).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; c');
  });
});

describe('the same alarms as the HTML board (Copilot, PR #154)', () => {
  it('a snapshot older than 30 minutes is called stale, in both views', () => {
    const late = { ...opts, now: () => new Date('2026-09-30T22:40:00Z') };
    expect(renderLlmsTxt(late)).toContain('WARNING: this snapshot is stale (taken 2026-09-30T22:01:00Z)');
    expect(renderMarkdown(late)).toContain('**WARNING: this snapshot is stale');
  });
  it('a truth check older than three hours is OVERDUE, never "Double-checked"', () => {
    const v = { ...opts, meta: { ...meta, checked_at: '2026-10-01T01:30:00Z' }, now: () => new Date('2026-10-01T01:40:00Z') };
    const txt = renderLlmsTxt(v);
    expect(txt).toContain('Truth check OVERDUE: last double-checked 2026-09-30T22:11:00Z');
    expect(txt).not.toContain('Double-checked 2026-09-30');
    expect(txt).not.toContain('WARNING: this snapshot is stale');
  });
  it('an empty board says no data has been collected', () => {
    expect(renderLlmsTxt({ ...opts, records: [] })).toContain('WARNING: no status data has been collected yet');
  });
  it('fresh data carries no warning', () => {
    expect(renderLlmsTxt(opts)).not.toContain('WARNING');
  });
});

describe('inline Markdown in vendor text stays text (Copilot second pass, PR #154)', () => {
  const v = [{ vendor: 'x ![p](https://tracker.example/pixel) [l](javascript:alert(1)) `c`', service: 'x', severity: 'degraded', incidentName: '', description: '', sourceUrl: '', checkedAt: '' }];
  it('brackets and backticks are escaped in both views, so no image or link forms', () => {
    for (const out of [renderMarkdown({ ...opts, records: v }), renderLlmsTxt({ ...opts, records: v })]) {
      expect(out).not.toMatch(/!\[p\]\(/);
      expect(out).not.toMatch(/(^|[^\\])\[l\]\(/);
      expect(out).toContain('!\\[p\\]');
      expect(out).toContain('\\`c\\`');
    }
  });
});

describe('ASCII folding cannot re-create markup (Copilot third pass, PR #154)', () => {
  it('full-width look-alikes are dropped, not mapped to < ! [ (', () => {
    const v = [{ vendor: 'v ＜img src=x＞ ！［p］（https://t.example） café', service: 'x', severity: 'degraded', incidentName: '', description: '', sourceUrl: '', checkedAt: '' }];
    const txt = renderLlmsTxt({ ...opts, records: v });
    expect(txt).not.toContain('<img');
    expect(txt).not.toMatch(/!\[p\]\(/);
    expect(txt).toContain('cafe'); // accents still fold to ASCII
  });
});
