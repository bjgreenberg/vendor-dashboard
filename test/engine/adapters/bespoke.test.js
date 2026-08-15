import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBetterStackSections } from '../../../src/engine/adapters/betterstack.js';
import { parseSorryApp } from '../../../src/engine/adapters/sorryapp.js';
import { SEVERITY } from '../../../src/engine/severity.js';
import { parseGoogle } from '../../../src/engine/adapters/google.js';
import { parseApple } from '../../../src/engine/adapters/apple.js';
import { parseOkta } from '../../../src/engine/adapters/okta.js';
import { parseSalesforce } from '../../../src/engine/adapters/salesforce.js';
import { parseConcur } from '../../../src/engine/adapters/concur.js';
import { parseBetterStack } from '../../../src/engine/adapters/betterstack.js';
import { parseMicrosoft } from '../../../src/engine/adapters/microsoft.js';

const json = (n) => JSON.parse(readFileSync(new URL(`../../fixtures/${n}.json`, import.meta.url), 'utf8'));
const text = (n) => readFileSync(new URL(`../../fixtures/${n}`, import.meta.url), 'utf8');
const now = () => new Date('2026-07-30T12:00:00Z');

/** Every adapter must satisfy this contract, so the collector can treat them uniformly. */
const ADAPTERS = [
  ['google', () => parseGoogle(json('Google-appsstatus'), { vendor: 'Google', now })],
  ['apple', () => parseApple(json('Apple'), { vendor: 'Apple', now })],
  ['okta', () => parseOkta(text('Okta-statuspage.html'), { vendor: 'Okta', now })],
  ['salesforce', () => parseSalesforce(json('Salesforce-Tableau'), { vendor: 'Tableau', now })],
  ['concur', () => parseConcur(json('Concur-incidents'), { vendor: 'Concur', banner: json('Concur-banner'), now })],
  ['sorryapp', () => parseSorryApp(json('Iorad-sorryapp'), { vendor: 'Iorad', now })],
  ['betterstack', () => parseBetterStack(text('Stormboard-betterstack.html'), { vendor: 'Stormboard', now })],
  ['microsoft', () => parseMicrosoft(json('Microsoft'), { vendor: 'Microsoft', now })],
];

describe('adapter contract — uniform record shape', () => {
  for (const [name, run] of ADAPTERS) {
    it(`${name} returns a well-formed record`, () => {
      const r = run();
      expect(r.vendor, `${name}.vendor`).toEqual(expect.any(String));
      expect(Object.values(SEVERITY), `${name}.severity`).toContain(r.severity);
      expect(r.description, `${name}.description`).toEqual(expect.any(String));
      expect(Array.isArray(r.components), `${name}.components`).toBe(true);
      expect(Array.isArray(r.warnings), `${name}.warnings`).toBe(true);
      expect(r.checkedAt).toBe('2026-07-30T12:00:00.000Z');
    });
  }
});

describe('adapter contract — every adapter fails closed (H4, H6, H7)', () => {
  for (const [name, , ] of ADAPTERS) void name;

  const NULL_CASES = [
    ['google', () => parseGoogle(null, { vendor: 'G', now })],
    ['apple', () => parseApple(null, { vendor: 'A', now })],
    ['okta', () => parseOkta(null, { vendor: 'O', now })],
    ['salesforce', () => parseSalesforce(null, { vendor: 'S', now })],
    ['concur', () => parseConcur(null, { vendor: 'C', now })],
    ['sorryapp', () => parseSorryApp(null, { vendor: 'I', now })],
    ['betterstack', () => parseBetterStack(null, { vendor: 'B', now })],
    ['microsoft', () => parseMicrosoft(null, { vendor: 'M', now })],
  ];

  for (const [name, run] of NULL_CASES) {
    it(`${name}: null input yields UNKNOWN, never OPERATIONAL`, () => {
      const r = run();
      expect(r.severity).toBe(SEVERITY.UNKNOWN);
      expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
    });
  }

  const GARBAGE = [
    ['google', () => parseGoogle('nonsense', { vendor: 'G', now })],
    ['apple', () => parseApple({ nope: 1 }, { vendor: 'A', now })],
    ['okta', () => parseOkta('<html>no embedded data</html>', { vendor: 'O', now })],
    ['salesforce', () => parseSalesforce({}, { vendor: 'S', now })],
    ['concur', () => parseConcur({}, { vendor: 'C', now })],
    ['sorryapp', () => parseSorryApp({}, { vendor: 'I', now })],
    ['betterstack', () => parseBetterStack('<html>unrelated page</html>', { vendor: 'B', now })],
    ['microsoft', () => parseMicrosoft({}, { vendor: 'M', now })],
  ];

  for (const [name, run] of GARBAGE) {
    it(`${name}: unrecognisable payload yields UNKNOWN and does not throw`, () => {
      expect(run).not.toThrow();
      expect(run().severity).toBe(SEVERITY.UNKNOWN);
    });
  }
});

describe('google', () => {
  it('reports operational when no incident is unresolved', () => {
    expect(parseGoogle(json('Google-appsstatus'), { vendor: 'Google', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('breaks out the affected product when an incident is open', () => {
    const payload = [
      {
        service_name: 'Gmail',
        external_desc: 'Delivery delays',
        severity: 'high',
        status_impact: 'SERVICE_DISRUPTION',
        most_recent_update: { status: 'SERVICE_DISRUPTION', text: 'Investigating delays.' },
      },
    ];
    const r = parseGoogle(payload, { vendor: 'Google', now });
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
    expect(r.components.map((c) => c.name)).toContain('Gmail');
  });
});

describe('apple', () => {
  it('reports operational when no service has an unresolved event', () => {
    expect(parseApple(json('Apple'), { vendor: 'Apple', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('surfaces a service with an active event', () => {
    const payload = {
      services: [
        { serviceName: 'iCloud Mail', events: [{ eventStatus: 'ongoing', messages: [{ message: 'Users affected' }] }] },
        { serviceName: 'App Store', events: [] },
      ],
    };
    const r = parseApple(payload, { vendor: 'Apple', now });
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
    expect(r.components.map((c) => c.name)).toContain('iCloud Mail');
  });
});

// Okta runs on Salesforce Experience Cloud; there is no public JSON API (all of
// summary.json, index.json, history.atom and history.rss return 401). The page
// embeds its incidents as JSON and the adapter parses that.
//
// This REPLACED a FeedBurner Atom source that returned 200 while its newest
// entry was 456 days old - a feed reporting healthy forever is the same silent
// rot as findings H6 and H7, just slower to notice.
describe('okta (embedded Salesforce records)', () => {
  it('reports operational when every incident is resolved', () => {
    expect(parseOkta(text('Okta-statuspage.html'), { vendor: 'Okta', now }).severity).toBe(
      SEVERITY.OPERATIONAL,
    );
  });

  it('detects an open incident and maps Okta\'s own category vocabulary', () => {
    const html = `<html><body>[{"attributes":{"type":"Incident__c"},"Id":"x","Name":"I-1",
      "Status__c":"Investigating","Category__c":"Major Service Disruption",
      "Incident_Title__c":"Login failures","Okta_Sub_Service__c":"Authentication"}]</body></html>`;
    const r = parseOkta(html, { vendor: 'Okta', now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components.map((c) => c.name)).toContain('Authentication');
  });

  it('grades a minor disruption below a major one', () => {
    const mk = (cat) => `<html>[{"attributes":{"type":"Incident__c"},"Status__c":"Open",
      "Category__c":"${cat}","Incident_Title__c":"t","Okta_Sub_Service__c":"s"}]</html>`;
    expect(parseOkta(mk('Minor Service Disruption'), { vendor: 'O', now }).severity).toBe(SEVERITY.DEGRADED);
    expect(parseOkta(mk('Major Service Disruption'), { vendor: 'O', now }).severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  // Brackets inside string values must not confuse the depth walk.
  it('extracts correctly when incident text contains brackets', () => {
    const html = `<html>[{"attributes":{"type":"Incident__c"},"Status__c":"Resolved",
      "Incident_Title__c":"Array [0] and object {x} in the title"}]</html>`;
    expect(parseOkta(html, { vendor: 'Okta', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('fails closed when the embedded data is absent rather than assuming health', () => {
    const r = parseOkta('<html><body>no data here</body></html>', { vendor: 'Okta', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/structure may have changed/i);
  });

  // The 347 KB real page must stay well inside the free plan's 10 ms CPU
  // budget, which is why this parser uses indexOf + a linear bracket walk
  // rather than a regex over the whole document.
  //
  // Asserted RELATIVE to a same-run baseline, not against an absolute
  // millisecond count (testing.md §7). A fixed `< 50ms` passes or fails
  // depending on how loaded the machine is — it would flake on a busy CI
  // runner and prove nothing on a fast laptop. A ratio cancels machine speed
  // out and still catches the regression that actually matters: someone
  // replacing the targeted scan with something linear in document size.
  // NO TIMING ASSERTION HERE, deliberately.
  //
  // This started as `expect(Date.now() - t0).toBeLessThan(50)`. Rewriting it as
  // a machine-relative ratio to dodge the "slow CI runner" flake did not help:
  // it failed 2 runs in 3 on an idle laptop, because at these durations the
  // measurement is dominated by JIT and GC noise, not by the algorithm.
  //
  // That is testing.md §7 in practice — a timing assertion is not a unit test,
  // and a flaky gate is worse than no gate because it trains people to re-run
  // until green. The CPU budget is a PERF concern and lives in its own tier:
  // `npm run perf` (scripts/perf-check.mjs), run on demand.
  //
  // What IS deterministic, and is what the parser must actually get right:
  // correctness is independent of how much surrounding document there is.
  const docOf = (size) =>
    'x'.repeat(size) +
    '[{"attributes":{"type":"Incident__c"},"Status__c":"Resolved"}]' +
    'y'.repeat(size);

  it('finds the payload regardless of how large the surrounding document is', () => {
    for (const size of [0, 1_000, 300_000, 1_500_000]) {
      expect(parseOkta(docOf(size), { vendor: 'Okta', now }).severity).toBe(SEVERITY.OPERATIONAL);
    }
  });

  it('finds the payload at the very start and the very end of the document', () => {
    const payload = '[{"attributes":{"type":"Incident__c"},"Status__c":"Resolved"}]';
    const pad = 'x'.repeat(200_000);
    for (const doc of [payload + pad, pad + payload]) {
      expect(parseOkta(doc, { vendor: 'Okta', now }).severity).toBe(SEVERITY.OPERATIONAL);
    }
  });
});

describe('salesforce / tableau', () => {
  it('reports operational when all active production instances are OK', () => {
    expect(parseSalesforce(json('Salesforce-Tableau'), { vendor: 'Tableau', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('ignores non-production and inactive instances', () => {
    const payload = {
      Instances: [
        { key: 'SANDBOX', environment: 'sandbox', isActive: true, status: 'MAJOR_INCIDENT_CORE', location: 'X' },
        { key: 'OLD', environment: 'production', isActive: false, status: 'MAJOR_INCIDENT_CORE', location: 'Y' },
        { key: 'PROD', environment: 'production', isActive: true, status: 'OK', location: 'Z' },
      ],
    };
    expect(parseSalesforce(payload, { vendor: 'Tableau', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('breaks out a degraded production instance', () => {
    const payload = {
      Instances: [{ key: 'NA1', environment: 'production', isActive: true, status: 'MAJOR_INCIDENT_CORE', location: 'US' }],
    };
    const r = parseSalesforce(payload, { vendor: 'Tableau', now });
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
    expect(r.components).toHaveLength(1);
  });
});

describe('concur', () => {
  it('reports operational when no incident is open and the banner is hidden', () => {
    const r = parseConcur(json('Concur-incidents'), { vendor: 'Concur', banner: json('Concur-banner'), now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('treats an incident with no end as open', () => {
    const payload = {
      incidents: [
        {
          affected_services: ['Expense'],
          data_centers: ['US2'],
          status: 'INVESTIGATION',
          severity: 'disruption',
          end_epoch: 0,
          created_epoch: 1785000000,
          messages: [{ message: 'Investigating' }],
        },
      ],
    };
    const r = parseConcur(payload, { vendor: 'Concur', now });
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('can scope to a single data centre', () => {
    const payload = {
      incidents: [
        { affected_services: ['Expense'], data_centers: ['EU2'], status: 'INVESTIGATION', severity: 'disruption', end_epoch: 0, created_epoch: 1785000000 },
      ],
    };
    expect(parseConcur(payload, { vendor: 'Concur', dataCenters: ['US2'], now }).severity).toBe(SEVERITY.OPERATIONAL);
    expect(parseConcur(payload, { vendor: 'Concur', dataCenters: ['EU2'], now }).severity).not.toBe(SEVERITY.OPERATIONAL);
  });
});

describe('sorryapp (iorad)', () => {
  it('reports operational from page.state', () => {
    expect(parseSorryApp(json('Iorad-sorryapp'), { vendor: 'Iorad', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('reports non-operational for any other state', () => {
    const r = parseSorryApp({ page: { state: 'major_outage', name: 'x', url: 'https://x' } }, { vendor: 'Iorad', now });
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });
});

// Audit finding H6: the predecessor matched a bare /\boperational\b/ against the
// WHOLE document. Better Stack's markup contains that word 7 times regardless
// of status, so Stormboard reported Operational unconditionally.
describe('betterstack (stormboard)', () => {
  it('reads the structural status modifier, not a loose word match', () => {
    const r = parseBetterStack(text('Stormboard-betterstack.html'), { vendor: 'Stormboard', now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('REGRESSION: a page containing the word "operational" but marked down is NOT green', () => {
    const html = `<html><body>
      <p>Our operational team is investigating. Operational updates follow.</p>
      <div class="status-page__overview-icon status-page__overview-icon--downtime"></div>
    </body></html>`;
    const r = parseBetterStack(html, { vendor: 'Stormboard', now });
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('fails closed when the structural marker is absent, rather than guessing', () => {
    const html = '<html><body>Everything is operational, honest.</body></html>';
    expect(parseBetterStack(html, { vendor: 'Stormboard', now }).severity).toBe(SEVERITY.UNKNOWN);
  });
});

// Audit finding H1 / decision D2.
describe('microsoft', () => {
  it('actually reads the payload instead of returning a hardcoded green row', () => {
    const down = { IsAllUp: false, Services: [{ Id: 'x', Name: 'Outlook.com', IsUp: false, Messages: [] }] };
    const r = parseMicrosoft(down, { vendor: 'Microsoft', now });
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
    expect(r.components.map((c) => c.name)).toContain('Outlook.com');
  });

  it('reports operational from the real all-clear payload', () => {
    expect(parseMicrosoft(json('Microsoft'), { vendor: 'Microsoft', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('labels itself as consumer services, since enterprise M365 is not in this feed', () => {
    const r = parseMicrosoft(json('Microsoft'), { vendor: 'Microsoft', now });
    expect(r.service).toMatch(/consumer/i);
  });

  it('warns that enterprise workloads are absent from this endpoint', () => {
    const r = parseMicrosoft(json('Microsoft'), { vendor: 'Microsoft', now });
    expect(r.warnings.join(' ')).toMatch(/enterprise|Exchange|Graph/i);
  });
});

describe('sorryapp components (iorad)', () => {
  // Reported 2026-08-01 for Seismic, and found by auditing every row with an
  // empty list: SorryApp publishes components on a SEPARATE endpoint, named in
  // the page payload as links.components.href. Without it the row showed a
  // page-level status and nothing underneath.
  const page = (state, components) => ({ page: { state, url: 'https://status.example' }, components });

  it('renders the components fetched from the second endpoint', () => {
    const r = parseSorryApp(
      page('operational', [
        { name: 'iorad capture', state: 'operational' },
        { name: 'iorad api', state: 'operational' },
      ]),
      { vendor: 'Iorad', now },
    );
    expect(r.components.map((c) => c.name)).toEqual(['iorad capture', 'iorad api']);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('dedupes repeated names, keeping the worst', () => {
    // iorad lists two "iorad editor" and two "iorad player" entries, one per
    // environment. Showing a service twice with different statuses reads as a
    // bug in the board rather than a fact about the vendor.
    const r = parseSorryApp(
      page('operational', [
        { name: 'iorad editor', state: 'operational' },
        { name: 'iorad editor', state: 'major_outage' },
      ]),
      { vendor: 'Iorad', now },
    );
    expect(r.components).toHaveLength(1);
    expect(r.components[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('lets a broken component override a green page-level state', () => {
    // The page summary is not authoritative over its own parts.
    const r = parseSorryApp(
      page('operational', [{ name: 'iorad api', state: 'major_outage' }]),
      { vendor: 'Iorad', now },
    );
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.description).toMatch(/iorad api/);
  });

  it('still works when the components endpoint could not be fetched', () => {
    // It is advisory: a failed second request must not sink the row.
    const r = parseSorryApp({ page: { state: 'operational' } }, { vendor: 'Iorad', now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components).toEqual([]);
  });
});

describe('betterstack /sections resources (stormboard)', () => {
  // Found by reading the status page's network log: the main page HTML carries
  // NO resource names, so the row had a page-level status and nothing under it.
  const frag = (rows) =>
    rows
      .map(
        ([state, name]) =>
          `<div class='d-flex align-items-center status-page__resource-name'>` +
          `<img src="https://x/assets/status_pages/${state}_small-abc.png" />\n${name}\n</div>`,
      )
      .join('');

  it('extracts each resource and its state from the icon filename', () => {
    // The state is read from the ICON FILENAME, not a colour: the inline hex
    // colours would change silently with a theme tweak.
    const c = parseBetterStackSections(frag([['operational', 'https://api.example.com/docs']]));
    expect(c).toHaveLength(1);
    expect(c[0].severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('names a resource by host, since these are monitored URLs', () => {
    const c = parseBetterStackSections(frag([['operational', 'https://api.stormboard.com/docs']]));
    expect(c[0].name).toBe('api.stormboard.com');
  });

  it('maps every state BetterStack ships and fails closed on a new one', () => {
    const sev = (s) => parseBetterStackSections(frag([[s, 'https://x.example/']]))[0].severity;
    expect(sev('operational')).toBe(SEVERITY.OPERATIONAL);
    expect(sev('degraded')).toBe(SEVERITY.DEGRADED);
    expect(sev('downtime')).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(sev('maintenance')).toBe(SEVERITY.MAINTENANCE);
    expect(sev('not_monitored')).toBe(SEVERITY.UNKNOWN);
    expect(sev('brand_new')).toBe(SEVERITY.UNKNOWN);
  });

  it('returns nothing rather than throwing when the fragment is absent', () => {
    for (const bad of ['', null, undefined, '<html>nope</html>']) {
      expect(parseBetterStackSections(bad)).toEqual([]);
    }
  });

  it('keeps a non-URL label as written', () => {
    expect(parseBetterStackSections(frag([['operational', 'Web application']]))[0].name).toBe(
      'Web application',
    );
  });
});

describe('empty catalogues fail closed (the worst([])-is-operational trap)', () => {
  it('microsoft: an EMPTY Services list yields UNKNOWN, never "everything is up"', () => {
    // Services: [] means the catalogue vanished — zero things were verified.
    // The legacy defect (H1) was precisely trusting this endpoint's optimism;
    // IsAllUp is attestation with no catalogue behind it, and a MISSING
    // IsAllUp must not read as up either.
    expect(parseMicrosoft({ Services: [] }, { vendor: 'M', now }).severity).toBe(SEVERITY.UNKNOWN);
    expect(parseMicrosoft({ Services: [], IsAllUp: true }, { vendor: 'M', now }).severity).toBe(
      SEVERITY.UNKNOWN,
    );
  });
});
