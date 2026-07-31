import { describe, it, expect } from 'vitest';
import { renderDashboard, esc, safeUrl, formatChicago } from '../../src/worker/render.js';

// Audit finding M4. Every field on this page is third-party content from ~35
// vendor status pages. A compromised or merely sloppy vendor page is untrusted
// input, and the render boundary is where it enters a PUBLIC site. The
// predecessor's stripHtml_ was a display cleaner mistaken for a sanitizer --
// harmless writing into a spreadsheet cell, a real vulnerability here.

const record = (over = {}) => ({
  vendor: 'V',
  service: 'V',
  severity: 'operational',
  incidentName: '',
  description: '',
  sourceUrl: '',
  components: [],
  warnings: [],
  checkedAt: '2026-07-30T12:00:00.000Z',
  ...over,
});

describe('esc', () => {
  it('escapes every HTML-significant character', () => {
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('renderDashboard — vendor content is never trusted', () => {
  it('escapes a script tag in an incident name', () => {
    const html = renderDashboard({
      records: [record({ severity: 'degraded', incidentName: '<script>alert(1)</script>' })],
      meta: null,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes markup in a description', () => {
    const html = renderDashboard({
      records: [record({ description: '<img src=x onerror=alert(1)>' })],
      meta: null,
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('escapes a component name broken out as a child', () => {
    const html = renderDashboard({
      records: [
        record({
          severity: 'major_outage',
          components: [{ name: '"><svg onload=alert(1)>', severity: 'major_outage' }],
        }),
      ],
      meta: null,
    });
    expect(html).not.toContain('<svg onload');
    expect(html).toContain('&lt;svg');
  });

  it('escapes content injected into the search haystack attribute', () => {
    const html = renderDashboard({
      records: [record({ vendor: '" onmouseover="alert(1)' })],
      meta: null,
    });
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('&quot;');
  });

  it('escapes a warning string', () => {
    const html = renderDashboard({ records: [record({ warnings: ['<b>bold</b>'] })], meta: null });
    expect(html).not.toContain('<b>bold</b>');
  });

  it('escapes the checked-at timestamp read back from storage', () => {
    const html = renderDashboard({
      records: [record()],
      meta: { checked_at: '"><script>x</script>' },
    });
    expect(html).not.toContain('<script>x</script>');
  });
});

describe('renderDashboard — presentation contract', () => {
  it('reports the impacted count in the headline', () => {
    const html = renderDashboard({
      records: [record({ severity: 'major_outage' }), record({ vendor: 'W', service: 'W' })],
      meta: null,
    });
    expect(html).toContain('1 service impacted');
  });

  it('says all operational when nothing is wrong', () => {
    expect(renderDashboard({ records: [record()], meta: null })).toContain('All systems operational');
  });

  it('does not count UNKNOWN as impacted, but does disclose it', () => {
    const html = renderDashboard({ records: [record({ severity: 'unknown' })], meta: null });
    expect(html).toContain('1 unchecked');
  });

  it('does not surface healthy components in the always-visible list', () => {
    const html = renderDashboard({
      records: [record({ components: [{ name: 'Subservice', severity: 'operational' }] })],
      meta: null,
    });
    // Healthy children live only inside the collapsed <details>, never in the
    // affected list above it.
    const beforeDetails = html.slice(0, html.indexOf('<details'));
    expect(beforeDetails).not.toContain('Subservice');
    expect(html).toContain('all healthy');
  });

  it('breaks out only the unhealthy children by default', () => {
    const html = renderDashboard({
      records: [
        record({
          severity: 'partial_outage',
          components: [
            { name: 'BrokenBit', severity: 'major_outage' },
            { name: 'FineBit', severity: 'operational' },
          ],
        }),
      ],
      meta: null,
    });
    const beforeDetails = html.slice(0, html.indexOf('<details'));
    expect(beforeDetails).toContain('BrokenBit');
    expect(beforeDetails).not.toContain('FineBit');
  });

  it('emits a nonce on the inline script when given one', () => {
    const html = renderDashboard({ records: [record()], meta: null, nonce: 'abc123' });
    expect(html).toContain('<script nonce="abc123">');
  });

  it('reuses the site chrome, stylesheet and shared theme control', () => {
    const html = renderDashboard({ records: [record()], meta: null });
    // Site header + footer so the page reads as part of briangreenberg.net.
    expect(html).toContain('class="wordmark"');
    expect(html).toContain('href="/writing/"');
    expect(html).toContain('© 2008–2026 Brian Greenberg');
    // Same stylesheet and theme script -> shared appearance preference.
    expect(html).toContain('href="/assets/site.css"');
    expect(html).toContain('src="/assets/js/theme.js"');
    expect(html).toContain('data-mode="system"');
    expect(html).toContain('data-mode="light"');
    expect(html).toContain('data-mode="dark"');
  });

  it('includes a skip link and a labelled search input for keyboard users', () => {
    const html = renderDashboard({ records: [record()], meta: null });
    expect(html).toContain('class="skip"');
    expect(html).toContain('<label for="vs-q"');
  });

  it('styles status colours for both themes, with the explicit override winning', () => {
    const html = renderDashboard({ records: [record()], meta: null });
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain(':root:not([data-theme="light"])');
  });
});

// Regression: the deployed Worker rendered "All systems operational" against an
// EMPTY board before the first collection had run. Zero records means nothing
// was checked -- reporting that as health is exactly the false-green failure
// this rewrite exists to eliminate (findings H1, H4, H6, H7). Caught on the
// first live deploy, 2026-07-31.
describe('renderDashboard — an empty board is not a healthy board', () => {
  it('does NOT claim all systems operational when there are no records', () => {
    const html = renderDashboard({ records: [], meta: null });
    expect(html).not.toContain('All systems operational');
  });

  it('says explicitly that no data has been collected', () => {
    const html = renderDashboard({ records: [], meta: null });
    expect(html).toMatch(/no status data|awaiting first collection/i);
  });

  it('marks the empty state as unknown, not ok', () => {
    const html = renderDashboard({ records: [], meta: null });
    expect(html).toContain('headline--unknown');
  });
});

// A dashboard that shows hour-old data as though it were current is the same
// silent rot in a different place: the collector can stop and the page keeps
// looking fine. This is the dead-man's switch for our own cron.
describe('renderDashboard — staleness is surfaced', () => {
  const fresh = '2026-07-31T12:00:00.000Z';
  const record = { vendor: 'V', service: 'V', severity: 'operational', incidentName: '', description: '', sourceUrl: '', components: [], warnings: [], checkedAt: fresh };

  it('does not warn when the snapshot is recent', () => {
    const html = renderDashboard({
      records: [record],
      meta: { checked_at: fresh },
      now: () => new Date('2026-07-31T12:05:00.000Z'),
    });
    expect(html).not.toMatch(/may be stale/i);
  });

  it('warns when the snapshot is older than two collection intervals', () => {
    const html = renderDashboard({
      records: [record],
      meta: { checked_at: fresh },
      now: () => new Date('2026-07-31T13:30:00.000Z'),
    });
    expect(html).toMatch(/may be stale/i);
  });
});

// The Worker answers on both briangreenberg.net and *.workers.dev. Letting a
// search engine index the workers.dev address would create a duplicate page
// competing with the real one.
describe('renderDashboard — only the canonical host is indexable', () => {
  const r = [{ vendor: 'V', service: 'V', severity: 'operational', incidentName: '', description: '', sourceUrl: '', components: [], warnings: [], checkedAt: '2026-07-31T12:00:00.000Z' }];

  it('allows indexing on the canonical host', () => {
    const html = renderDashboard({ records: r, meta: null, host: 'briangreenberg.net' });
    expect(html).toContain('content="index, follow"');
  });

  it('blocks indexing on the workers.dev address', () => {
    const html = renderDashboard({ records: r, meta: null, host: 'vendor-dashboard.gsysd.workers.dev' });
    expect(html).toContain('content="noindex, nofollow"');
  });

  it('points canonical at the real URL regardless of which host served it', () => {
    const html = renderDashboard({ records: r, meta: null, host: 'vendor-dashboard.gsysd.workers.dev' });
    expect(html).toContain('href="https://briangreenberg.net/service-status"');
  });
});

// Vendor status pages are linked from each card. `sourceUrl` comes FROM the
// vendor payload, so it is untrusted input that is stored in D1 and replayed to
// every visitor — a javascript: URL in an href would be stored XSS.
describe('safeUrl — vendor-supplied URLs are validated before use in href', () => {
  it('permits http and https', () => {
    expect(safeUrl('https://status.example.com')).toBe('https://status.example.com/');
    expect(safeUrl('http://status.example.com/x')).toBe('http://status.example.com/x');
  });

  it('rejects javascript:, data: and vbscript:', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeUrl('vbscript:msgbox')).toBe('');
  });

  it('rejects malformed input without throwing', () => {
    expect(safeUrl('not a url')).toBe('');
    expect(safeUrl('')).toBe('');
    expect(safeUrl(null)).toBe('');
    expect(safeUrl(42)).toBe('');
  });
});

describe('renderDashboard — vendor status page links', () => {
  const withUrl = (sourceUrl) => ({
    vendor: 'V', service: 'V', severity: 'operational', incidentName: '',
    description: '', sourceUrl, components: [], warnings: [],
    checkedAt: '2026-07-31T12:00:00.000Z',
  });

  it('links the service name to the vendor status page', () => {
    const html = renderDashboard({ records: [withUrl('https://status.example.com')], meta: null });
    expect(html).toContain('href="https://status.example.com/"');
    expect(html).toContain('rel="noopener nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it('renders plain text rather than a link when the URL is unsafe', () => {
    const html = renderDashboard({ records: [withUrl('javascript:alert(1)')], meta: null });
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).toContain('<span class="vs-name">V</span>');
  });

  it('renders plain text when the vendor supplied no URL', () => {
    const html = renderDashboard({ records: [withUrl('')], meta: null });
    expect(html).toContain('<span class="vs-name">V</span>');
  });
});

// Requirement: clicking a service expands ALL of its components, not just the
// affected ones — e.g. Google -> Docs, Sheets, Meet, GCP.
describe('renderDashboard — expandable component list', () => {
  const rec = (components, severity = 'operational') => ({
    vendor: 'Google', service: 'Google', severity, incidentName: '', description: '',
    sourceUrl: '', components, warnings: [], checkedAt: '2026-07-31T12:00:00.000Z',
  });

  it('discloses every component inside a native <details>', () => {
    const html = renderDashboard({
      records: [rec([
        { name: 'Gmail', severity: 'operational' },
        { name: 'Drive', severity: 'operational' },
        { name: 'Meet', severity: 'operational' },
      ])],
      meta: null,
    });
    expect(html).toContain('<details');
    const details = html.slice(html.indexOf('<details'));
    expect(details).toContain('Gmail');
    expect(details).toContain('Drive');
    expect(details).toContain('Meet');
  });

  it('summarises the component count and how many are affected', () => {
    const html = renderDashboard({
      records: [rec([
        { name: 'Gmail', severity: 'major_outage' },
        { name: 'Drive', severity: 'operational' },
      ], 'major_outage')],
      meta: null,
    });
    expect(html).toMatch(/2 components · 1 affected/);
  });

  it('says all healthy when nothing is affected', () => {
    const html = renderDashboard({ records: [rec([{ name: 'Gmail', severity: 'operational' }])], meta: null });
    expect(html).toMatch(/1 component · all healthy/);
  });

  it('omits the disclosure entirely for a vendor with no components', () => {
    const html = renderDashboard({ records: [rec([])], meta: null });
    expect(html).not.toContain('<details');
  });

  it('makes component names searchable so "gmail" finds Google', () => {
    const html = renderDashboard({ records: [rec([{ name: 'Gmail', severity: 'operational' }])], meta: null });
    expect(html).toMatch(/data-search="[^"]*gmail[^"]*"/);
  });
});

describe('renderDashboard — timestamp', () => {
  const rec = { vendor: 'V', service: 'V', severity: 'operational', incidentName: '', description: '', sourceUrl: '', components: [], warnings: [], checkedAt: '2026-07-31T17:45:00.000Z' };

  it('renders Chicago time server-side so it is meaningful without JavaScript', () => {
    const html = renderDashboard({
      records: [rec],
      meta: { checked_at: '2026-07-31T17:45:00.000Z' },
      now: () => new Date('2026-07-31T17:50:00.000Z'),
    });
    // 17:45 UTC is 12:45 PM CDT.
    expect(html).toMatch(/12:45\s*PM\s*CDT/);
  });

  it('emits a machine-readable datetime the client can localise', () => {
    const html = renderDashboard({
      records: [rec],
      meta: { checked_at: '2026-07-31T17:45:00.000Z' },
      now: () => new Date('2026-07-31T17:50:00.000Z'),
    });
    expect(html).toContain('<time id="vs-checked" datetime="2026-07-31T17:45:00.000Z"');
  });

  it('formatChicago returns empty for an unparseable timestamp', () => {
    expect(formatChicago('not-a-date')).toBe('');
  });
});

describe('renderDashboard — favicon', () => {
  it('points at the site favicon so the tab icon matches the rest of the site', () => {
    // The site has no /favicon.ico, so without an explicit link the browser
    // falls back to a 404 and the tab shows a blank icon.
    const html = renderDashboard({ records: [], meta: null });
    expect(html).toContain('<link rel="icon" href="/assets/img/favicon.png" type="image/png">');
  });
});
