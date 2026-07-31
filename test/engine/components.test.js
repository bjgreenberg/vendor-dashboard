import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStatuspage } from '../../src/engine/adapters/statuspage.js';
import { parseGoogle } from '../../src/engine/adapters/google.js';
import { SEVERITY } from '../../src/engine/severity.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));
const now = () => new Date('2026-07-31T12:00:00Z');

// Vendors model their status pages in three incompatible ways, and naively
// listing leaf components produces infrastructure noise rather than services:
//
//   groups = products, leaves = data centres   NetSuite (9 / 275), Docusign, Jamf
//   groups = regions,  leaves = products       1Password (4 / 84), Monday.com
//   no groups,         leaves = services       GitHub, OpenAI, Anthropic
//
// A reader wants services. NetSuite's 275 leaves are "US Ashburn 1" repeated 39
// times per product; 1Password's 84 are "1Password.com website" once per region.

describe('componentLevel: group — when the vendor puts products at group level', () => {
  const netsuiteLike = {
    page: { url: 'https://ns' },
    status: { indicator: 'none' },
    incidents: [],
    components: [
      { id: 'g1', name: 'Application UI', status: 'operational', group: true },
      { id: 'g2', name: 'SuiteTalk', status: 'degraded_performance', group: true },
      { id: 'c1', name: 'US Ashburn 1', status: 'operational', group_id: 'g1' },
      { id: 'c2', name: 'US Phoenix S', status: 'operational', group_id: 'g1' },
      { id: 'c3', name: 'US Ashburn 1', status: 'degraded_performance', group_id: 'g2' },
    ],
  };

  it('lists the products, not the data centres', () => {
    const r = parseStatuspage(netsuiteLike, { vendor: 'NetSuite', componentLevel: 'group', now });
    expect(r.components.map((c) => c.name)).toEqual(['Application UI', 'SuiteTalk']);
  });

  it('uses each group\'s own published status', () => {
    const r = parseStatuspage(netsuiteLike, { vendor: 'NetSuite', componentLevel: 'group', now });
    const suiteTalk = r.components.find((c) => c.name === 'SuiteTalk');
    expect(suiteTalk.severity).toBe(SEVERITY.DEGRADED);
  });

  it('still derives overall severity from the products', () => {
    const r = parseStatuspage(netsuiteLike, { vendor: 'NetSuite', componentLevel: 'group', now });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });

  it('falls back to leaves when the vendor publishes no groups', () => {
    const flat = {
      page: { url: 'https://x' },
      status: { indicator: 'none' },
      incidents: [],
      components: [{ id: 'a', name: 'API', status: 'operational' }],
    };
    const r = parseStatuspage(flat, { vendor: 'X', componentLevel: 'group', now });
    expect(r.components.map((c) => c.name)).toEqual(['API']);
  });
});

describe('deduplication — the same service repeated per region collapses to one row', () => {
  const onePasswordLike = {
    page: { url: 'https://1p' },
    status: { indicator: 'none' },
    incidents: [],
    components: [
      { id: 'g1', name: 'USA/Global', status: 'operational', group: true },
      { id: 'g2', name: 'Europe', status: 'operational', group: true },
      { id: 'a', name: '1Password.com website', status: 'operational', group_id: 'g1' },
      { id: 'b', name: '1Password.com website', status: 'major_outage', group_id: 'g2' },
      { id: 'c', name: 'Sign-in', status: 'operational', group_id: 'g1' },
    ],
  };

  it('collapses repeated names into one component', () => {
    const r = parseStatuspage(onePasswordLike, { vendor: '1Password', now });
    expect(r.components.map((c) => c.name).sort()).toEqual(['1Password.com website', 'Sign-in']);
  });

  it('keeps the WORST status across regions, never the healthiest', () => {
    const r = parseStatuspage(onePasswordLike, { vendor: '1Password', now });
    const site = r.components.find((c) => c.name === '1Password.com website');
    expect(site.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('leaves already-unique component lists untouched', () => {
    const r = parseStatuspage(fixture('GitHub'), { vendor: 'GitHub', now });
    const names = r.components.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(5);
  });
});

// Google publishes a product catalogue at products.json, separate from its
// incidents feed. Without it the row had nothing to expand.
describe('google — product catalogue', () => {
  const products = {
    products: [
      { title: 'Gmail', id: '1' },
      { title: 'Google Drive', id: '2' },
      { title: 'Google Meet', id: '3' },
    ],
  };

  it('lists every product when the catalogue is supplied', () => {
    const r = parseGoogle([], { vendor: 'Google', products, now });
    expect(r.components.map((c) => c.name)).toEqual(['Gmail', 'Google Drive', 'Google Meet']);
    expect(r.components.every((c) => c.severity === SEVERITY.OPERATIONAL)).toBe(true);
  });

  it('marks only the products with an open incident', () => {
    const incidents = [
      {
        service_name: 'Gmail',
        external_desc: 'Delivery delays',
        most_recent_update: { status: 'SERVICE_DISRUPTION', text: 'Investigating.' },
      },
    ];
    const r = parseGoogle(incidents, { vendor: 'Google', products, now });
    const gmail = r.components.find((c) => c.name === 'Gmail');
    const drive = r.components.find((c) => c.name === 'Google Drive');
    expect(gmail.severity).not.toBe(SEVERITY.OPERATIONAL);
    expect(drive.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('still works with no catalogue, falling back to incident-derived components', () => {
    const incidents = [
      { service_name: 'Gmail', most_recent_update: { status: 'SERVICE_DISRUPTION', text: 'x' } },
    ];
    const r = parseGoogle(incidents, { vendor: 'Google', now });
    expect(r.components.map((c) => c.name)).toContain('Gmail');
  });
});

// Okta renders its service list client-side from a Salesforce Aura endpoint that
// is not reachable without a browser, so the catalogue is DECLARED in config.
// A hand-maintained list is exactly the kind of thing that rots silently, so the
// adapter detects drift rather than trusting it.
describe('okta — declared service catalogue with drift detection', () => {
  const CATALOG = ['Core Platform', 'Single Sign-On', 'MFA', 'Workflows'];
  // The marker record must itself be RESOLVED, otherwise the scaffold counts as
  // an open incident and every case starts non-operational.
  const page = (incidents) =>
    `<html><body>[{"attributes":{"type":"Incident__c"},"Status__c":"Resolved"}${incidents
      .map((i) => ',' + JSON.stringify(i))
      .join('')}]</body></html>`;

  it('lists every catalogued service when all are healthy', async () => {
    const { parseOkta } = await import('../../src/engine/adapters/okta.js');
    const r = parseOkta(page([]), { vendor: 'Okta', serviceCatalog: CATALOG, now });
    expect(r.components.map((c) => c.name)).toEqual(CATALOG);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('marks only the sub-service named by an open incident', async () => {
    const { parseOkta } = await import('../../src/engine/adapters/okta.js');
    const r = parseOkta(
      page([{ Status__c: 'Investigating', Category__c: 'Major Service Disruption',
              Okta_Sub_Service__c: 'MFA', Incident_Title__c: 'MFA failures' }]),
      { vendor: 'Okta', serviceCatalog: CATALOG, now },
    );
    expect(r.components.find((c) => c.name === 'MFA').severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components.find((c) => c.name === 'Workflows').severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('WARNS when an incident names a service missing from the catalogue', async () => {
    const { parseOkta } = await import('../../src/engine/adapters/okta.js');
    const r = parseOkta(
      page([{ Status__c: 'Open', Category__c: 'Service Disruption',
              Okta_Sub_Service__c: 'Okta Aerial', Incident_Title__c: 'x' }]),
      { vendor: 'Okta', serviceCatalog: CATALOG, now },
    );
    expect(r.warnings.join(' ')).toMatch(/Okta Aerial.*catalog may be out of date/i);
  });

  it('falls back to incident-derived components with no catalogue configured', async () => {
    const { parseOkta } = await import('../../src/engine/adapters/okta.js');
    const r = parseOkta(
      page([{ Status__c: 'Open', Category__c: 'Service Disruption', Okta_Sub_Service__c: 'MFA' }]),
      { vendor: 'Okta', now },
    );
    expect(r.components.map((c) => c.name)).toEqual(['MFA']);
  });
});

// Zoom splits three products across regions at GROUP level - "Zoom Phone -
// APAC", "Zoom CX - EMEA", "Zoom Virtual Agent - JAPAN" - turning 13 real
// products into 33 rows.
describe('region-suffix stripping', () => {
  it('collapses a product split across regions into one row', async () => {
    const { parseStatuspage: parse } = await import('../../src/engine/adapters/statuspage.js');
    const payload = {
      page: { url: 'https://z' }, status: { indicator: 'none' }, incidents: [],
      components: [
        { id: 'g1', name: 'Zoom Phone - Global', status: 'operational', group: true },
        { id: 'g2', name: 'Zoom Phone - APAC', status: 'major_outage', group: true },
        { id: 'g3', name: 'Zoom Phone - EMEA', status: 'operational', group: true },
        { id: 'g4', name: 'Zoom Meetings', status: 'operational', group: true },
      ],
    };
    const r = parse(payload, { vendor: 'Zoom', componentLevel: 'group', now });
    expect(r.components.map((c) => c.name).sort()).toEqual(['Zoom Meetings', 'Zoom Phone']);
  });

  it('keeps the worst regional status after collapsing', async () => {
    const { parseStatuspage: parse } = await import('../../src/engine/adapters/statuspage.js');
    const payload = {
      page: { url: 'https://z' }, status: { indicator: 'none' }, incidents: [],
      components: [
        { id: 'g1', name: 'Zoom CX - Global', status: 'operational', group: true },
        { id: 'g2', name: 'Zoom CX - JAPAN', status: 'partial_outage', group: true },
      ],
    };
    const r = parse(payload, { vendor: 'Zoom', componentLevel: 'group', now });
    expect(r.components).toHaveLength(1);
    expect(r.components[0].severity).toBe(SEVERITY.PARTIAL_OUTAGE);
  });

  it('is conservative: does not mangle names that merely contain a dash', async () => {
    const { stripRegionSuffix } = await import('../../src/engine/adapters/statuspage.js');
    expect(stripRegionSuffix('Jamf Pro - Standard')).toBe('Jamf Pro - Standard');
    expect(stripRegionSuffix('Zoom CX - Premium')).toBe('Zoom CX - Premium');
    expect(stripRegionSuffix('Sign-in')).toBe('Sign-in');
    expect(stripRegionSuffix('Zoom Phone - APAC')).toBe('Zoom Phone');
    expect(stripRegionSuffix('Zoom Phone - HONG KONG/CHINA')).toBe('Zoom Phone');
  });
});

// Lucid publishes "Document List (US)", "Document List (EU)" — one service per
// region — while other vendors use parentheses for legitimate acronyms.
describe('parenthetical region suffixes', () => {
  it('strips a parenthetical region', async () => {
    const { stripRegionSuffix } = await import('../../src/engine/adapters/statuspage.js');
    expect(stripRegionSuffix('Document List (US)')).toBe('Document List');
    expect(stripRegionSuffix('Document List (EU)')).toBe('Document List');
    expect(stripRegionSuffix('Primary Application (North America)')).toBe('Primary Application');
  });

  it('PRESERVES legitimate parenthetical acronyms', async () => {
    const { stripRegionSuffix } = await import('../../src/engine/adapters/statuspage.js');
    for (const n of [
      'Multi-factor Authentication (MFA)',
      'Bring Your Own IP (BYOIP)',
      'KnowBe4 Security Awareness Training (KSAT)',
      'Jamf Cloud Distribution Service (JCDS)',
      'Microsoft 365 (Consumer)',
      'SMS (Text)',
      'Cloud Access Security Broker (CASB)',
    ]) {
      expect(stripRegionSuffix(n)).toBe(n);
    }
  });
});

describe('region stripping — deliberate exclusions', () => {
  it('collapses AUS along with US and EU', async () => {
    const { stripRegionSuffix } = await import('../../src/engine/adapters/statuspage.js');
    expect(stripRegionSuffix('Document List (AUS)')).toBe('Document List');
  });

  it('does NOT collapse a government cloud into the commercial one', async () => {
    // A gov cloud has its own availability; hiding it inside the commercial row
    // would conceal a real distinction.
    const { stripRegionSuffix } = await import('../../src/engine/adapters/statuspage.js');
    expect(stripRegionSuffix('Document List (Gov)')).toBe('Document List (Gov)');
  });
});
