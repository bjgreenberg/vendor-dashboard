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

// ---------------------------------------------------------------------------
// The RICH source, found after correcting a wrong conclusion. /api/feed/{id}
// returns 400 for every product name, which I read as "Microsoft publishes no
// per-app health". It only proved that ONE route rejects those ids. A second
// API, /api/posts/{id}, serves the consumer products; the bundle builds it as
// a bare relative string so a grep for quoted absolute paths missed it.
// ---------------------------------------------------------------------------

import { parseMicrosoftConsumer, parseMicrosoftAdminPost } from '../../../src/engine/adapters/microsoft.js';

const consumerLive = JSON.parse(readFileSync('test/fixtures/Microsoft-consumer.json', 'utf8'));
const adminLive = JSON.parse(readFileSync('test/fixtures/Microsoft-adminpost.json', 'utf8'));
const consumer = (p) => parseMicrosoftConsumer(p, { vendor: 'Microsoft', now });
// The clock is an explicit PARAMETER, never wall-clock time.
//
// First attempt used `new Date()`, and these tests began failing 30 minutes
// after the fixture was recorded because the freshness guard correctly
// rejected a stale post. Second attempt derived the clock FROM the payload,
// which broke the opposite way: a deliberately-stale payload also got a stale
// clock and looked fresh. Passing it in keeps both cases honest (testing.md §7).
const FIXED = new Date('2026-08-01T01:00:00Z');
/** Clock just after a payload's own timestamp — for the recorded live fixture. */
const justAfter = (p) => new Date(Date.parse(p.LastUpdatedTime) + 60_000);
const admin = (p, v = 'Microsoft 365', at = FIXED) =>
  parseMicrosoftAdminPost(p, { vendor: v, now: () => at });

describe('microsoft consumer products', () => {
  it('covers the apps a reader actually asks about', () => {
    const r = consumer(consumerLive);
    const names = r.components.map((c) => c.name).join(' | ');
    for (const app of ['Office for the web', 'Outlook.com', 'OneDrive', 'Copilot']) {
      expect(names).toContain(app);
    }
    expect(r.components.length).toBeGreaterThanOrEqual(10);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('labels the row as consumer and warns that business services are excluded', () => {
    const r = consumer(consumerLive);
    expect(r.service).toBe('Microsoft (Consumer Services)');
    expect(r.warnings.join(' ')).toMatch(/Exchange, SharePoint and Intune/);
  });

  it('takes the worst service as the row severity and names it', () => {
    const p = [
      { ServiceDisplayName: 'Outlook.com', Status: 'Operational' },
      { ServiceDisplayName: 'OneDrive', Status: 'Unavailable' },
    ];
    const r = consumer(p);
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.description).toMatch(/OneDrive/);
    expect(r.description).not.toMatch(/Outlook/);
  });

  it('fails closed on unknown vocabulary and malformed payloads', () => {
    expect(consumer([{ ServiceDisplayName: 'X', Status: 'Sparkly' }]).severity).toBe(SEVERITY.UNKNOWN);
    for (const bad of [null, undefined, [], {}, 'nope']) {
      expect(consumer(bad).severity).toBe(SEVERITY.UNKNOWN);
    }
  });

  it('keeps a healthy service readable when a sibling is broken', () => {
    const r = consumer([
      { ServiceDisplayName: 'Outlook.com', Status: 'Operational' },
      { ServiceDisplayName: 'OneDrive', Status: 'Sparkly' },
    ]);
    // One unreadable service must not blank the row, but must not read green.
    expect(r.components).toHaveLength(2);
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });
});

describe('microsoft admin-centre meta status', () => {
  it('reads the live payload and names the product from the vendor', () => {
    const r = admin(adminLive, 'Microsoft 365', justAfter(adminLive));
    expect(r.service).toBe('Microsoft 365 (Admin Center reachability)');
    expect(admin(adminLive, 'Microsoft Power Platform', justAfter(adminLive)).service).toBe(
      'Microsoft Power Platform (Admin Center reachability)',
    );
  });

  it('warns that it does not measure the services inside', () => {
    // The overclaiming trap: "Microsoft 365 - Operational" would be read as
    // "my email works". This row does not measure that.
    expect(admin(adminLive, 'Microsoft 365', justAfter(adminLive)).warnings.join(' ')).toMatch(/only whether the admin centre itself is reachable/i);
  });

  it('refuses a stale post rather than repeating Available forever', () => {
    const stale = { Status: 'Available', LastUpdatedTime: '2026-07-30T00:00:00+00:00' };
    expect(admin(stale).severity).toBe(SEVERITY.UNKNOWN);
  });

  it('fails closed on missing status, bad timestamp or unknown vocabulary', () => {
    expect(admin({ LastUpdatedTime: FIXED.toISOString() }).severity).toBe(SEVERITY.UNKNOWN);
    expect(admin({ Status: 'Available', LastUpdatedTime: 'nope' }).severity).toBe(SEVERITY.UNKNOWN);
    expect(admin({ Status: 'Sparkly', LastUpdatedTime: FIXED.toISOString() }).severity).toBe(
      SEVERITY.UNKNOWN,
    );
  });
});
