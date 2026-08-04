import { describe, it, expect } from 'vitest';
import { renderDashboard, esc, safeUrl, formatChicago, humanizeWarning } from '../../src/worker/render.js';

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

// Warnings serve two audiences. "fetch returned HTTP 404" tells an operator what
// happened and tells a visitor nothing; config-drift notes are pure maintenance
// signal. The raw strings stay in /api/status and the logs.
describe('humanizeWarning', () => {
  it('translates an HTTP error into plain language', () => {
    expect(humanizeWarning('fetch returned HTTP 404')).toMatch(/did not return a status/i);
    expect(humanizeWarning('fetch returned HTTP 404')).not.toMatch(/HTTP|404|fetch/);
  });

  it('distinguishes a vendor-side failure from a missing response', () => {
    expect(humanizeWarning('fetch returned HTTP 503')).toMatch(/having trouble/i);
  });

  it('translates unreachability', () => {
    expect(humanizeWarning('fetch failed: ECONNRESET')).toMatch(/could not be reached/i);
    expect(humanizeWarning('fetch failed: ECONNRESET')).not.toMatch(/ECONNRESET/);
  });

  it('translates a shape change', () => {
    expect(humanizeWarning('response was not valid JSON')).toMatch(/changed how it publishes/i);
  });

  it('HIDES operator-only maintenance warnings', () => {
    expect(humanizeWarning('configured component "DNS" matched no component in the live payload')).toBeNull();
    expect(humanizeWarning('incident names sub-service "X" ... catalog may be out of date')).toBeNull();
  });

  it('passes through text already written for readers', () => {
    const note = 'Covers Microsoft consumer services. Business services such as Exchange are only reported inside each organisation\'s own admin centre.';
    expect(humanizeWarning(note)).toBe(note);
  });
});

describe('renderDashboard — warnings shown to readers', () => {
  const rec = (warnings) => ({
    vendor: 'Microsoft', service: 'Microsoft', severity: 'unknown',
    incidentName: '', description: 'Status could not be determined.',
    sourceUrl: '', components: [], warnings, checkedAt: '2026-07-31T12:00:00.000Z',
  });

  it('never shows raw HTTP diagnostics on the page', () => {
    const html = renderDashboard({ records: [rec(['fetch returned HTTP 404'])], meta: null });
    expect(html).not.toContain('fetch returned HTTP 404');
    expect(html).toMatch(/did not return a status/i);
  });

  it('renders no warning line at all when every warning is operator-only', () => {
    const html = renderDashboard({
      records: [rec(['configured component "DNS" matched no component in the live payload'])],
      meta: null,
    });
    // Scope to the card: the class name also appears in the stylesheet.
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    expect(card).not.toContain('vs-warn');
    expect(card).not.toContain('DNS');
  });
});

// This page defaults to dark, unlike the rest of the site which follows the
// system. The theme key is SHARED with briangreenberg.net, so the default must
// not be persisted - writing it would change the whole site's default.
describe('renderDashboard — dark by default', () => {
  const html = () => renderDashboard({ records: [], meta: null, nonce: 'n1' });

  it('renders the document dark before any script runs', () => {
    expect(html()).toContain('<html lang="en" data-theme="dark">');
  });

  it('seeds dark only when the visitor has no stored preference', () => {
    expect(html()).toMatch(/if \(!localStorage\.getItem\('bgnet-theme'\)\)/);
  });

  it('NEVER writes the default to the shared storage key', () => {
    // setItem must appear nowhere in the seeding logic; persisting would change
    // briangreenberg.net's default too.
    const seed = html().slice(0, html().indexOf('/assets/js/theme.js'));
    expect(seed).not.toContain('setItem');
  });

  it('falls back to dark when storage is unavailable', () => {
    expect(html()).toMatch(/catch[\s\S]{0,80}setAttribute\('data-theme', 'dark'\)/);
  });
});

describe('renderDashboard — logo placement', () => {
  const rec = {
    vendor: 'GitHub', service: 'GitHub', severity: 'operational', incidentName: '',
    description: '', sourceUrl: 'https://www.githubstatus.com', components: [],
    warnings: [], checkedAt: '2026-07-31T12:00:00.000Z',
  };

  // The mark leads the row: it is the identity anchor, at the position the eye
  // starts. Placing it after the name arrives too late to aid recognition.
  it('renders the mark BEFORE the vendor name', () => {
    const html = renderDashboard({ records: [rec], meta: null });
    const head = html.slice(html.indexOf('<div class="vs-head">'), html.indexOf('</h2>'));
    expect(head).toContain('vs-logo');
    expect(head.indexOf('vs-logo')).toBeLessThan(head.indexOf('GitHub'));
  });

  // Status is already carried by the card's coloured border AND the pill text,
  // so the dot was redundant beside a mark.
  it('replaces the status dot when a mark exists', () => {
    const html = renderDashboard({ records: [rec], meta: null });
    const head = html.slice(html.indexOf('<div class="vs-head">'), html.indexOf('</h2>'));
    expect(head).not.toContain('vs-dot--');
  });

  it('KEEPS the dot for a vendor with no mark, so no row loses its glyph', () => {
    const html = renderDashboard({
      records: [{ ...rec, vendor: 'NoSuchVendor', service: 'NoSuchVendor' }], meta: null,
    });
    const head = html.slice(html.indexOf('<div class="vs-head">'), html.indexOf('</h2>'));
    expect(head).toContain('vs-dot--');
    expect(head).not.toContain('vs-logo');
  });
});

describe('renderDashboard — logo legibility on both themes', () => {
  const html = () => renderDashboard({
    records: [{ vendor: 'Anthropic', service: 'Anthropic', severity: 'operational', incidentName: '',
      description: '', sourceUrl: '', components: [], warnings: [], checkedAt: '2026-07-31T12:00:00.000Z' }],
    meta: null,
  });

  // Several vendor favicons are dark marks on transparency (measured below 0.28
  // luminance) and would vanish on this page, which defaults to dark.
  it('gives every mark a chip so dark logos remain legible', () => {
    expect(html()).toMatch(/\.vs-logo\s*\{[^}]*background:\s*#ffffff/);
  });

  it('softens the chip in light mode rather than showing a white block', () => {
    expect(html()).toMatch(/data-theme="light"\]\s*\.vs-logo\s*\{[^}]*rgba\(0,0,0,\.03\)/);
  });

  it('constrains every mark to one fixed box so sizes look proportional', () => {
    const css = html();
    expect(css).toMatch(/\.vs-logo\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/);
    expect(css).toMatch(/\.vs-logo\s*\{[^}]*object-fit:\s*contain/);
  });

  it('does not cap the narrative narrower than the cards', () => {
    expect(html()).not.toMatch(/\.vs-intro\s*\{[^}]*max-width/);
  });
});

// The site shares with plain intent links and no third-party SDKs; this page
// must not undercut that privacy posture.
describe('renderDashboard — sharing', () => {
  const rec = { vendor: 'GitHub', service: 'GitHub', severity: 'operational', incidentName: '',
    description: '', sourceUrl: '', components: [], warnings: [], checkedAt: '2026-07-31T12:00:00.000Z' };
  const html = (over = {}) => renderDashboard({ records: [rec], meta: null, ...over });

  it('emits og and twitter tags with an ABSOLUTE image url', () => {
    const h = html();
    expect(h).toContain('property="og:image" content="https://briangreenberg.net/service-status/card.jpg"');
    expect(h).toContain('name="twitter:card" content="summary_large_image"');
    expect(h).toContain('property="og:image:width" content="1200"');
    expect(h).toContain('og:image:alt');
  });

  it('describes the LIVE board so a share during an incident does not claim all-clear', () => {
    const impacted = { ...rec, severity: 'major_outage' };
    expect(html({ records: [impacted] })).toMatch(/og:description[^>]*1 currently impacted/);
    expect(html()).toMatch(/og:description[^>]*All operational/);
  });

  it('shares with plain intent links and no third-party script', () => {
    const h = html();
    expect(h).toContain('linkedin.com/sharing/share-offsite');
    expect(h).toContain('bsky.app/intent/compose');
    // No SDK loaders.
    expect(h).not.toMatch(/platform\.twitter\.com|connect\.facebook\.net|platform\.linkedin\.com/);
  });

  it('gives every row a stable anchor instead of 41 share widgets', () => {
    const h = html();
    // The id is the deep-link surface. The visible "#" glyph that used to
    // advertise it was removed 2026-08-03 (read as an artifact on both touch
    // and desktop); /service-status#github still works.
    expect(h).toContain('<article id="github"');
    // One share bar for the page, not one per service.
    expect(h.match(/class="share-bar/g)).toHaveLength(1);
  });
});

describe('rows are deep-linkable without a visible permalink glyph', () => {
  // Two reports about the same "#": a phone showed it on tap (sticky hover,
  // 2026-08-01) and a desktop showed it on hover (by design, 2026-08-03).
  // Twice-misread means the affordance failed: it reads as a rendering
  // artifact next to the status pill, and its only job was advertising a
  // deep link the card id already provides. The glyph is gone; the
  // capability is not.
  const doc = () => renderDashboard({
    records: [{ vendor: '1Password', service: '1Password', severity: 'operational',
                incidentName: '', description: 'All good', sourceUrl: 'https://status.1password.com',
                components: [], warnings: [], checkedAt: '2026-08-03T14:00:00.000Z' }],
    meta: null,
  });

  it('emits no permalink glyph anywhere', () => {
    expect(doc()).not.toContain('vs-anchor');
    // Nor the bare character in card markup, which is what a reader saw.
    expect(doc()).not.toMatch(/aria-label="Link to /);
  });

  it('still gives every card a stable id, so existing deep links keep working', () => {
    expect(doc()).toContain('id="1password"');
  });

  it('still emphasises a deep-linked row on arrival', () => {
    expect(doc()).toMatch(/\.vs-card:target\s*\{[^}]*box-shadow/);
  });
});

describe('per-component detail', () => {
  // Reported 2026-08-01: "AWS doesn't seem to be breaking down what the
  // specific failure is. It just is a general label." The adapters HAD been
  // filling in per-component descriptions — AWS's event-log excerpt naming the
  // affected regions and what happened, Oracle's and Azure DevOps' affected
  // regions, IBM's incident title — and childLi dropped them on the floor. A
  // reader saw "Multiple services / Degraded" and nothing about the failure.
  const withChild = (child) =>
    renderDashboard({
      records: [
        record({
          vendor: 'AWS',
          severity: 'degraded',
          components: [child],
        }),
      ],
      meta: { checked_at: '2026-08-01T12:00:00.000Z' },
      now: () => new Date('2026-08-01T12:01:00.000Z'),
    });

  // Assert on the ELEMENT, not the class name: the stylesheet in the same
  // document also mentions `vs-child-detail`, so a document-wide check passes
  // whether or not anything is actually rendered.
  const DETAIL_EL = '<p class="vs-child-detail">';

  it('renders the detail of an impacted component', () => {
    const html = withChild({
      name: 'Multiple services',
      severity: 'degraded',
      description: 'UAE — The Region has suffered damage and is unavailable.',
    });
    expect(html).toContain(DETAIL_EL);
    expect(html).toContain('suffered damage');
  });

  it('escapes the detail, which is third-party text', () => {
    const html = withChild({
      name: 'X',
      severity: 'degraded',
      description: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('renders NO detail element for a healthy component', () => {
    // A healthy component's description is empty by construction; emitting the
    // element anyway would put an empty box under all 268 AWS services.
    const html = withChild({ name: 'Amazon S3', severity: 'operational', description: '' });
    expect(html).not.toContain(DETAIL_EL);
  });

  it('renders no detail element when an impacted component has none', () => {
    const html = withChild({ name: 'X', severity: 'degraded', description: '' });
    expect(html).not.toContain(DETAIL_EL);
  });
});
