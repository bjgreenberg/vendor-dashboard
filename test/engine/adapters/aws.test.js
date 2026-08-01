import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAws, awsSeverityOf } from '../../../src/engine/adapters/aws.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Fixture recorded live 2026-08-01 (event_log trimmed to one entry each so the
// file stays reviewable). It contains one RESOLVED event and two active ones,
// which is exactly the mix the adapter has to get right.

const now = () => new Date('2026-08-01T01:20:00Z');
const live = JSON.parse(readFileSync('test/fixtures/AWS-currentevents.json', 'utf8'));
const parse = (p) => parseAws(p, { vendor: 'AWS', now });

describe('aws current events', () => {
  it('reports only the ACTIVE events from the recorded payload', () => {
    // RESOLVED events stay in this feed. Counting them would report AWS
    // degraded over an incident that closed hours ago.
    const r = parse(live);
    expect(r.components).toHaveLength(2);
    expect(r.components.map((c) => c.name)).toEqual([
      'Multiple services — UAE',
      'Multiple services — Bahrain',
    ]);
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });

  it('names the region, because an AWS event without one means nothing', () => {
    expect(parse(live).components.every((c) => c.name.includes('—'))).toBe(true);
  });

  it('treats an empty feed as operational', () => {
    const r = parse([]);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components).toEqual([]);
  });

  it('excludes an event that has an end_time even without the RESOLVED marker', () => {
    // Both conditions are required: trusting the text alone would miss an
    // event closed without the marker.
    const r = parse([{ summary: 'Increased Error Rates', end_time: 1785524075, service_name: 'S3' }]);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('excludes a RESOLVED event that has no end_time', () => {
    // ...and trusting end_time alone would miss the converse.
    const r = parse([{ summary: '[RESOLVED] Elevated Packet Loss', end_time: null, service_name: 'S3' }]);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('never classifies an ACTIVE event as operational, however odd the wording', () => {
    // The event exists, so something is being reported. Falling through to
    // healthy because the wording is unfamiliar is the false green this
    // project exists to prevent.
    const r = parse([{ summary: 'Something entirely novel', end_time: null, service_name: 'S3', region_name: 'X' }]);
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('maps AWS wording onto the severity scale', () => {
    expect(awsSeverityOf('Increased Error Rates')).toBe(SEVERITY.DEGRADED);
    expect(awsSeverityOf('Elevated Packet Loss')).toBe(SEVERITY.DEGRADED);
    expect(awsSeverityOf('Service is unavailable')).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(awsSeverityOf('Scheduled maintenance')).toBe(SEVERITY.MAINTENANCE);
  });

  it('takes the worst active event as the row severity', () => {
    const r = parse([
      { summary: 'Increased Error Rates', end_time: null, service_name: 'EC2', region_name: 'A' },
      { summary: 'API unavailable', end_time: null, service_name: 'S3', region_name: 'B' },
    ]);
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('fails closed on a malformed payload', () => {
    for (const bad of [null, undefined, {}, 'nope', 42]) {
      expect(parse(bad).severity).toBe(SEVERITY.UNKNOWN);
    }
  });
});


describe('the row is findable by the name people actually use', () => {
  // Reported 2026-08-01: "I don't see AWS". The row WAS on the board and
  // degraded — it was named "Amazon Web Services", and the dashboard filter
  // indexes vendor + service + component names, so typing "aws" matched
  // nothing and scanning for it found nothing either.
  const haystack = (r) =>
    [r.vendor, r.service, ...r.components.map((c) => c.name)].join(' ').toLowerCase();

  it.each(['aws', 'amazon', 'amazon web services'])('is matched by "%s"', (term) => {
    expect(haystack(parse(live))).toContain(term);
  });

  it('still matches when nothing is wrong and there are no components', () => {
    // The healthy path has an empty component list, so the names must come
    // from the vendor and service labels alone.
    expect(haystack(parse([]))).toContain('aws');
    expect(haystack(parse([]))).toContain('amazon');
  });
});
