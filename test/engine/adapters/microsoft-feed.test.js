import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMicrosoftFeed } from '../../../src/engine/adapters/microsoft.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Microsoft retired portal.office.com/api/servicestatus/index — it and the
// admin.microsoft.com fallback both answer 404 "No HTTP resource was found".
// That left Microsoft permanently `unknown` on the board. This adapter reads
// the replacement feed at status.cloud.microsoft, found by reading the status
// site's JS bundle.
//
// Fixture is the real payload, recorded 2026-08-01.

const now = () => new Date('2026-08-01T00:10:00Z');
const live = readFileSync('test/fixtures/Microsoft-adminfeed.xml', 'utf8');
const parse = (xml) => parseMicrosoftFeed(xml, { vendor: 'Microsoft', now });

const feed = (status, title = 'Microsoft Admin Center') => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Microsoft Admin Center Status</title>
<item><guid isPermaLink="false">x</guid><title>${title}</title>
${status === null ? '' : `<status>${status}</status>`}
<pubDate>Sat, 01 Aug 2026 00:05:00 Z</pubDate></item></channel></rss>`;

describe('microsoft admin-centre feed', () => {
  it('reads the recorded live payload as operational', () => {
    const r = parse(live);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components).toHaveLength(1);
    expect(r.components[0].name).toBe('Microsoft Admin Center');
  });

  it('labels the row for exactly what it measures', () => {
    // The retired endpoint covered CONSUMER services; this one does not. An
    // inherited "Microsoft (Consumer Services)" label would now be a lie.
    const r = parse(live);
    expect(r.service).toBe('Microsoft 365 (Admin Center)');
    expect(r.warnings.join(' ')).toMatch(/admin centre itself is reachable/i);
    expect(r.warnings.join(' ')).toMatch(/Exchange, Teams, SharePoint and Intune/);
  });

  it('maps Microsoft vocabulary onto the severity scale', () => {
    expect(parse(feed('Available')).severity).toBe(SEVERITY.OPERATIONAL);
    expect(parse(feed('Degraded')).severity).toBe(SEVERITY.DEGRADED);
    expect(parse(feed('Investigating')).severity).toBe(SEVERITY.DEGRADED);
    expect(parse(feed('Interruption')).severity).toBe(SEVERITY.PARTIAL_OUTAGE);
    expect(parse(feed('Unavailable')).severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(parse(feed('Maintenance')).severity).toBe(SEVERITY.MAINTENANCE);
  });

  it('is case-insensitive about the status word', () => {
    expect(parse(feed('AVAILABLE')).severity).toBe(SEVERITY.OPERATIONAL);
    expect(parse(feed('available')).severity).toBe(SEVERITY.OPERATIONAL);
  });

  // --- fail-closed paths. The governing rule: never green without evidence.

  it('fails closed on a status word it has never seen', () => {
    const r = parse(feed('Sunny'));
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ') + r.description).toMatch(/no recognisable status/i);
  });

  it('fails closed when the status element is missing entirely', () => {
    // The shape-drift signal. Microsoft dropping <status> must not read green.
    expect(parse(feed(null)).severity).toBe(SEVERITY.UNKNOWN);
  });

  it('fails closed on an empty feed, non-RSS body, or the 404 JSON', () => {
    for (const bad of [
      '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>',
      '<html><body>Sign in</body></html>',
      '{"Message":"No HTTP resource was found that matches the request URI"}',
      '',
      null,
      undefined,
    ]) {
      expect(parse(bad).severity).toBe(SEVERITY.UNKNOWN);
    }
  });

  it('never reports operational from a body that merely contains the word', () => {
    // Audit finding H6 was a bare word match on a whole document. The word
    // "Available" appears in this page's own prose; only the <status> element
    // may decide severity.
    const decoy =
      '<?xml version="1.0"?><rss version="2.0"><channel>' +
      '<description>This site shows whether the service is Available</description>' +
      '<item><title>Microsoft Admin Center</title><pubDate>x</pubDate></item>' +
      '</channel></rss>';
    expect(parse(decoy).severity).toBe(SEVERITY.UNKNOWN);
  });

  it('reports every item as a component, not only the unhealthy ones', () => {
    const two = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Microsoft Admin Center</title><status>Available</status></item>
      <item><title>Power Platform Admin Center</title><status>Degraded</status></item>
      </channel></rss>`;
    const r = parse(two);
    expect(r.components.map((c) => c.name)).toEqual([
      'Microsoft Admin Center',
      'Power Platform Admin Center',
    ]);
    expect(r.severity).toBe(SEVERITY.DEGRADED); // worst wins
    expect(r.description).toMatch(/Power Platform Admin Center/);
  });
});
