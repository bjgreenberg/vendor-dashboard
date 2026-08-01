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
    // degraded over an incident that closed hours ago. The fixture holds one
    // resolved Mumbai event and two active ones, both for the same service.
    const r = parse(live);
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.components.map((c) => c.name)).toEqual(['Multiple services']);
  });

  it('groups by SERVICE, keeping regions out of the component name', () => {
    // AWS events are per service per region, so naming components
    // "S3 — Bahrain" turns the row into a list of points of presence. The
    // same roll-up applied to Zoom, Docusign, OutSystems, Azure DevOps and
    // Oracle: name the service, put the regions in the description.
    const r = parse([
      { summary: 'Increased Error Rates', end_time: null, service_name: 'Amazon S3', region_name: 'UAE' },
      { summary: 'Increased Error Rates', end_time: null, service_name: 'Amazon S3', region_name: 'Bahrain' },
      { summary: 'Elevated latency', end_time: null, service_name: 'Amazon EC2', region_name: 'Ireland' },
    ]);
    expect(r.components.map((c) => c.name).sort()).toEqual(['Amazon EC2', 'Amazon S3']);
    for (const c of r.components) {
      expect(c.name).not.toMatch(/UAE|Bahrain|Ireland/);
    }
    const s3 = r.components.find((c) => c.name === 'Amazon S3');
    expect(s3.description).toMatch(/UAE/);
    expect(s3.description).toMatch(/Bahrain/);
  });

  it('gives a grouped service the WORST severity across its regions', () => {
    const r = parse([
      { summary: 'Elevated latency', end_time: null, service_name: 'Amazon S3', region_name: 'UAE' },
      { summary: 'S3 is unavailable', end_time: null, service_name: 'Amazon S3', region_name: 'Bahrain' },
    ]);
    expect(r.components).toHaveLength(1);
    expect(r.components[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
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

describe('aws lists its service catalogue', () => {
  // Reported 2026-08-01: "Why isn't AWS giving details on services". Cause:
  // currentevents publishes only ACTIVE events, so with nothing wrong the row
  // had no services at all — the same gap found on Oracle, IBM, Concur,
  // Seismic, Iorad and Stormboard. The catalogue is a separate document, found
  // by reading the Health Dashboard's network log.
  const cat = (names) =>
    JSON.stringify(names.map((n) => ({ service: n.toLowerCase(), service_name: n, region_id: 'us-east-1' })));

  const withCat = (events, names) =>
    parseAws(events, { vendor: 'AWS', now, catalogueText: cat(names) });

  it('lists every catalogued service when nothing is wrong', () => {
    const r = withCat([], ['Amazon S3', 'Amazon EC2']);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components.map((c) => c.name).sort()).toEqual(['Amazon EC2', 'Amazon S3']);
  });

  it('dedupes the catalogue, which lists a service once per region', () => {
    // 5,848 service-region pairs cover only 268 distinct services.
    const raw = JSON.stringify([
      { service_name: 'Amazon S3', region_id: 'us-east-1' },
      { service_name: 'Amazon S3', region_id: 'eu-west-1' },
    ]);
    const r = parseAws([], { vendor: 'AWS', now, catalogueText: raw });
    expect(r.components).toHaveLength(1);
  });

  it('marks only the services an active event names', () => {
    const r = withCat(
      [{ summary: 'Increased Error Rates', end_time: null, service_name: 'Amazon S3', region_name: 'UAE' }],
      ['Amazon S3', 'Amazon EC2'],
    );
    expect(r.components.find((c) => c.name === 'Amazon S3').severity).toBe(SEVERITY.DEGRADED);
    expect(r.components.find((c) => c.name === 'Amazon EC2').severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('still shows an event whose service is not in the catalogue', () => {
    // AWS labels multi-service incidents "Multiple services", which is not a
    // catalogue entry; dropping it would hide a real outage.
    const r = withCat(
      [{ summary: 'Increased Error Rates', end_time: null, service_name: 'Multiple services', region_name: 'UAE' }],
      ['Amazon S3'],
    );
    expect(r.components.map((c) => c.name)).toContain('Multiple services');
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });

  it('names only AFFECTED services in the summary line', () => {
    // Once the catalogue landed, `components` became all services sorted worst
    // first, so slicing it listed healthy ones as though they were impacted.
    const r = withCat(
      [{ summary: 'Increased Error Rates', end_time: null, service_name: 'Amazon S3', region_name: 'UAE' }],
      ['Amazon S3', 'Amazon EC2', 'Amazon Athena'],
    );
    expect(r.description).toMatch(/Amazon S3/);
    expect(r.description).not.toMatch(/Amazon EC2|Amazon Athena/);
  });

  it('sorts impacted services above healthy ones', () => {
    const r = withCat(
      [{ summary: 'S3 is unavailable', end_time: null, service_name: 'Amazon S3', region_name: 'UAE' }],
      ['AAA First Alphabetically', 'Amazon S3'],
    );
    expect(r.components[0].name).toBe('Amazon S3');
  });

  it('is stable across repeated calls', () => {
    // CATALOGUE_RE is global; a stale lastIndex would make the SECOND
    // collection of the day return no services.
    const names = ['Amazon S3', 'Amazon EC2'];
    expect(withCat([], names).components.length).toBe(2);
    expect(withCat([], names).components.length).toBe(2);
  });

  it('falls back to event-only components when the catalogue is unavailable', () => {
    // Advisory: a failed catalogue fetch must not sink the row.
    const r = parseAws(
      [{ summary: 'Increased Error Rates', end_time: null, service_name: 'Amazon S3', region_name: 'UAE' }],
      { vendor: 'AWS', now },
    );
    expect(r.components.map((c) => c.name)).toEqual(['Amazon S3']);
  });
});
