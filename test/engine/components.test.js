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
