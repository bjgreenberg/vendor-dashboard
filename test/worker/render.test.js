import { describe, it, expect } from 'vitest';
import { renderDashboard, esc } from '../../src/worker/render.js';

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

  it('collapses a healthy vendor instead of listing its services', () => {
    const html = renderDashboard({
      records: [record({ components: [{ name: 'Subservice', severity: 'operational' }] })],
      meta: null,
    });
    expect(html).toContain('all healthy');
    expect(html).not.toContain('>Subservice<');
  });

  it('breaks out only the unhealthy children', () => {
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
    expect(html).toContain('BrokenBit');
    expect(html).not.toContain('FineBit');
  });

  it('emits a nonce on the inline script when given one', () => {
    const html = renderDashboard({ records: [record()], meta: null, nonce: 'abc123' });
    expect(html).toContain('<script nonce="abc123">');
  });

  it('ships a three-state appearance control defaulting to System', () => {
    const html = renderDashboard({ records: [record()], meta: null });
    expect(html).toContain('data-theme-set="system"');
    expect(html).toContain('data-theme-set="light"');
    expect(html).toContain('data-theme-set="dark"');
    expect(html).toContain('data-theme="system"');
  });

  it('includes a skip link and a labelled search input for keyboard users', () => {
    const html = renderDashboard({ records: [record()], meta: null });
    expect(html).toContain('class="skip"');
    expect(html).toContain('<label for="q"');
  });

  it('styles both themes and lets the explicit override win over the media query', () => {
    const html = renderDashboard({ records: [record()], meta: null });
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain(':root[data-theme="light"]');
  });
});
