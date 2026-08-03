import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAws } from '../../../src/engine/adapters/aws.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// US vantage point, AWS edition (captured live 2026-08-03: both active
// events were Middle East — me-central-1 and me-south-1 — and they were the
// row's severity, with zero US impact).
//
// The polarity is fail-closed: an event only LOSES its vote when its region
// code is positively parsed AND positively foreign. Global services carry no
// region suffix, so they keep voting; so does anything whose code the parser
// does not recognise. Foreign events still surface on the card with their
// full detail — they inform, they don't vote.

const payload = JSON.parse(
  readFileSync(new URL('../../fixtures/AWS-currentevents-uae.json', import.meta.url), 'utf8'),
);
const now = () => new Date('2026-08-03T14:00:00Z');
const US = { scope: { regionPrefixes: ['us-'] } };

describe('AWS under US focus', () => {
  const r = parseAws(payload, { vendor: 'AWS', now, ...US });

  it('foreign-only events leave the row operational', () => {
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('the foreign trouble still shows on the card, with detail', () => {
    const c = r.components.find((x) => x.name === 'Multiple services');
    expect(c.severity).toBe(SEVERITY.DEGRADED);
    expect(c.description).toContain('UAE');
  });

  it('the row description says the events are outside the US focus', () => {
    expect(r.description).toMatch(/outside US focus/i);
    expect(r.incidentName).toBe('');
  });

  it('a global event (no region code) still votes despite the scope', () => {
    const global = [
      { service: 'cloudfront', service_name: 'Amazon CloudFront', region_name: '',
        summary: 'Increased Error Rates', end_time: null, event_log: [] },
    ];
    const g = parseAws(global, { vendor: 'AWS', now, ...US });
    expect(g.severity).toBe(SEVERITY.DEGRADED);
  });

  it('a US-region event votes exactly as before', () => {
    const us = [
      { service: 'ec2-us-east-1', service_name: 'Amazon EC2', region_name: 'N. Virginia',
        summary: 'Increased API Error Rates', end_time: null, event_log: [] },
    ];
    const u = parseAws(us, { vendor: 'AWS', now, ...US });
    expect(u.severity).toBe(SEVERITY.DEGRADED);
    expect(u.incidentName).toContain('Increased API Error Rates');
  });

  it('unscoped behavior is unchanged: everything votes', () => {
    const un = parseAws(payload, { vendor: 'AWS', now });
    expect(un.severity).toBe(SEVERITY.DEGRADED);
  });
});
