import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAws, awsSeverityOf } from '../../../src/engine/adapters/aws.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Fixture recorded live 2026-08-01 (event_log trimmed to one entry each so the
// file stays reviewable). It contains one RESOLVED event and two active ones,
// which is exactly the mix the adapter has to get right.

const now = () => new Date('2026-08-01T01:20:00Z');
const live = JSON.parse(readFileSync('test/fixtures/AWS-currentevents.json', 'utf8'));
// The catalogue comes from CONFIG (`serviceCatalog`), the same mechanism Okta
// uses, so the pure engine imports no JSON of its own. Tests read the real
// committed list rather than a fixture, so a truncated or renamed catalogue
// fails here.
const AWS_CATALOGUE = JSON.parse(readFileSync('config/vendors.json', 'utf8')).vendors.find(
  (v) => v.name === 'AWS',
).serviceCatalog;

const parse = (p) => parseAws(p, { vendor: 'AWS', now, serviceCatalog: AWS_CATALOGUE });

describe('aws current events', () => {
  /** Only the components an event actually marked — the rest is the catalogue. */
  const impacted = (r) => r.components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  it('reports only the ACTIVE events from the recorded payload', () => {
    // RESOLVED events stay in this feed. Counting them would report AWS
    // degraded over an incident that closed hours ago. The fixture holds one
    // resolved Mumbai event and two active ones, both for the same service.
    //
    // Asserted on IMPACTED components: every row also carries the full
    // build-time service catalogue, so the component list is ~269 long.
    const r = parse(live);
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(impacted(r).map((c) => c.name)).toEqual(['Multiple services']);
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
    expect(impacted(r).map((c) => c.name).sort()).toEqual(['Amazon EC2', 'Amazon S3']);
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
    expect(impacted(r)).toHaveLength(1);
    expect(impacted(r)[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('treats an empty feed as operational, still listing the catalogue', () => {
    const r = parse([]);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(impacted(r)).toEqual([]);
    expect(r.components.length).toBeGreaterThan(200); // the whole service list
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
  // had no services at all.
  //
  // The catalogue is a BUILD-TIME snapshot (config/aws-services.json). Reading
  // the live 1.25 MB document cost a subrequest and ~1.7 ms CPU every cycle,
  // against a 10 ms per-invocation ceiling production was already exceeding --
  // that overrun killed collection for 3.5 hours the same day. AWS's service
  // list changes only when AWS launches a service.
  const impacted = (r) => r.components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  it('lists the whole service catalogue when nothing is wrong', () => {
    const r = parse([]);
    const names = r.components.map((c) => c.name);
    expect(names.length).toBeGreaterThan(200);
    // Real names from the snapshot — AWS's own labels, not tidied.
    for (const svc of ['AWS Lambda', 'Amazon API Gateway', 'AWS Account Management']) {
      expect(names).toContain(svc);
    }
  });

  it('contains no duplicates, though the source lists a service once per region', () => {
    // The live document is 5,848 service-region pairs covering 268 services.
    const names = parse([]).components.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks only the services an active event names', () => {
    const r = parse([
      { summary: 'Increased Error Rates', end_time: null, service_name: 'AWS Lambda', region_name: 'UAE' },
    ]);
    expect(r.components.find((c) => c.name === 'AWS Lambda').severity).toBe(SEVERITY.DEGRADED);
    expect(r.components.find((c) => c.name === 'Amazon API Gateway').severity).toBe(SEVERITY.OPERATIONAL);
    expect(impacted(r)).toHaveLength(1);
  });

  it('still shows an event whose service is not in the catalogue', () => {
    // AWS labels multi-service incidents "Multiple services", which is not a
    // catalogue entry; dropping it would hide a real outage.
    const r = parse([
      {
        summary: 'Increased Error Rates',
        end_time: null,
        service_name: 'Multiple services',
        region_name: 'UAE',
      },
    ]);
    expect(r.components.map((c) => c.name)).toContain('Multiple services');
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });

  it('names only AFFECTED services in the summary line', () => {
    // Once the catalogue landed, `components` became every service sorted
    // worst-first, so slicing it listed healthy ones as though impacted.
    const r = parse([
      { summary: 'Increased Error Rates', end_time: null, service_name: 'AWS Lambda', region_name: 'UAE' },
    ]);
    expect(r.description).toMatch(/AWS Lambda/);
    expect(r.description).not.toMatch(/Amazon API Gateway/);
  });

  it('sorts impacted services above healthy ones', () => {
    const r = parse([
      { summary: 'Lambda is unavailable', end_time: null, service_name: 'AWS Lambda', region_name: 'UAE' },
    ]);
    expect(r.components[0].name).toBe('AWS Lambda');
  });

  it('is stable across repeated calls', () => {
    expect(parse([]).components.length).toBe(parse([]).components.length);
  });

  it('the snapshot is a plausible catalogue, not a truncated fetch', () => {
    // scripts/fetch-aws-catalogue.mjs refuses to write fewer than 100 services;
    // this asserts the committed file honoured that.
    expect(parse([]).components.length).toBeGreaterThan(150);
  });
});

describe('aws says WHAT is affected, not just that something is', () => {
  // Reported 2026-08-01: "of the two services that are currently degraded, you
  // don't specify which ones they are. You just say multiples."
  //
  // AWS genuinely does not enumerate services for a MULTIPLE_SERVICES event --
  // those are region- or AZ-wide, and the ARN says so. The scope is stated only
  // in the event log, which the adapter was discarding in favour of the
  // top-level `summary` headline ("Increased Error Rates").
  const evt = (region, messages) => ({
    summary: 'Increased Error Rates',
    end_time: null,
    service_name: 'Multiple services',
    region_name: region,
    event_log: messages.map(([timestamp, message]) => ({ message, timestamp })),
  });

  it('describes the incident using the event log, not the headline', () => {
    const r = parse([evt('UAE', [[1, 'We are investigating issues.'], [2, 'Power issue in AZ mec1-az2.']])]);
    const c = r.components[0];
    expect(c.description).toContain('mec1-az2');
    expect(c.description).not.toBe('Increased Error Rates');
  });

  it('uses the NEWEST log entry, chosen by timestamp not position', () => {
    // Entries arrive oldest-first, but picking by timestamp survives AWS
    // reordering them; the newest is the current state of the incident.
    const r = parse([evt('UAE', [[900, 'Newest state.'], [100, 'Stale first update.']])]);
    expect(r.components[0].description).toContain('Newest state');
    expect(r.components[0].description).not.toContain('Stale');
  });

  it('names EVERY affected region, not just the first', () => {
    // Both regions were merged into one component and the description was
    // truncated, so only the first survived.
    const r = parse([
      evt('UAE', [[1, 'The UAE Region has suffered damage and is unavailable.']]),
      evt('Bahrain', [[1, 'The Bahrain Region has suffered damage and is unavailable.']]),
    ]);
    const bad = r.components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);
    expect(bad).toHaveLength(1);
    expect(bad[0].description).toContain('UAE');
    expect(bad[0].description).toContain('Bahrain');
  });

  it('keeps enough of a long message to reach the substance', () => {
    // AWS opens with boilerplate; the substance is in the NEXT sentence, so a
    // first-sentence excerpt described two regions identically and uselessly.
    const boiler = 'We are providing an update on the ongoing service disruption.';
    const meat = 'The Region has suffered damage and cannot support customer applications.';
    const r = parse([evt('UAE', [[1, `${boiler} ${meat}`]])]);
    expect(r.components[0].description).toContain('suffered damage');
  });

  it('cuts a long PROSE excerpt on a word boundary', () => {
    const long = `${'situation update regarding the affected region '.repeat(20)}`;
    const r = parse([evt('UAE', [[1, long]])]);
    // Ends after a whole word, not mid-token.
    expect(r.components[0].description).toMatch(/[a-z]…$/);
    expect(r.components[0].description).not.toMatch(/\bregio…$|\bsituati…$/);
  });

  it('still truncates safely when there is no word boundary to cut on', () => {
    // A single pathological token has no space to break at; a hard cut is the
    // correct fallback, and it must not throw or return the whole string.
    const r = parse([evt('UAE', [[1, 'x'.repeat(400)]])]);
    expect(r.components[0].description.length).toBeLessThan(320);
  });

  it('falls back to the summary when an event has no log', () => {
    const r = parse([
      { summary: 'Increased Error Rates', end_time: null, service_name: 'Amazon S3', region_name: 'UAE' },
    ]);
    expect(r.components[0].description).toContain('Increased Error Rates');
  });
});
