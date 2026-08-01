import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseIbmCloud, ibmSeverityOf } from '../../../src/engine/adapters/ibm.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Fixture trimmed from the real 2.44 MB payload (6 incidents + 4 non-incidents)
// so the file stays reviewable. The adapter reads RAW TEXT, never JSON.parse:
// measured 8.03 ms to parse the whole document versus 1.82 ms to scan, against
// a 10 ms free-plan budget for the entire run.

const now = () => new Date('2026-08-01T01:40:00Z');
const live = readFileSync('test/fixtures/IBM-enhancedstatus.json', 'utf8');
const parse = (t) => parseIbmCloud(t, { vendor: 'IBM Cloud', now });

/**
 * Build a payload with the given incidents, in the minified real shape.
 *
 * The resources entry needs a displayName: the adapter builds its component
 * list from the resourceID/displayName catalogue, and a payload with no usable
 * catalogue reports UNKNOWN rather than inventing a healthy row.
 */
const doc = (incidents) =>
  JSON.stringify({
    statusItems: incidents,
    resources: [{ resourceID: 'is-vpc', displayName: 'Virtual Private Cloud' }],
  });

describe('ibm cloud enhanced status', () => {
  it('reads the recorded payload as operational — every incident is resolved', () => {
    const r = parse(live);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.service).toBe('IBM Cloud');
  });

  it('ignores release notes and announcements entirely', () => {
    // 1,105 of 1,293 items in the real payload are release notes. Treating any
    // non-incident as a signal would report IBM permanently degraded.
    const r = parse(
      doc([
        { type: 'release_note', state: '', name: 'CLI version available' },
        { type: 'announcement', state: '', name: 'Action required' },
        { type: 'security', state: '', name: 'Bulletin' },
      ]),
    );
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('reports an ACTIVE incident against the affected service', () => {
    const r = parse(
      doc([{ type: 'incident', state: 'investigating', sev: 1, name: 'VPC disruption', resourceIDs: ['is-vpc'] }]),
    );
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    // Named by DISPLAY name, not the raw resourceID: the catalogue maps
    // "is-vpc" to "Virtual Private Cloud", which is what a reader recognises.
    expect(r.components[0].name).toBe('Virtual Private Cloud');
    expect(r.components[0].description).toBe('VPC disruption');
  });

  it('excludes resolved incidents', () => {
    const r = parse(doc([{ type: 'incident', state: 'resolved', sev: 1, name: 'Old outage' }]));
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('treats an incident with an UNRECOGNISED state as active', () => {
    // Fail closed: an incident whose state we cannot confirm is finished is an
    // incident we must not report as over.
    const r = parse(doc([{ type: 'incident', state: 'brand_new_state', sev: 3, name: 'X' }]));
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('treats an incident with an EMPTY state as active', () => {
    const r = parse(doc([{ type: 'incident', state: '', sev: 2, name: 'X' }]));
    expect(r.severity).toBe(SEVERITY.PARTIAL_OUTAGE);
  });

  it('maps IBM severity, and never lets an unreadable sev read healthy', () => {
    expect(ibmSeverityOf(1)).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(ibmSeverityOf(2)).toBe(SEVERITY.PARTIAL_OUTAGE);
    expect(ibmSeverityOf(3)).toBe(SEVERITY.DEGRADED);
    expect(ibmSeverityOf(undefined)).toBe(SEVERITY.DEGRADED);
    expect(ibmSeverityOf('nonsense')).toBe(SEVERITY.DEGRADED);
  });

  it('takes the worst active incident', () => {
    const r = parse(
      doc([
        { type: 'incident', state: 'monitoring', sev: 3, name: 'A' },
        { type: 'incident', state: 'investigating', sev: 1, name: 'B' },
      ]),
    );
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  // --- the H6 guard. "No incidents" must mean "we read the feed and it was
  // empty", never "we could not read the feed".

  it('fails closed when the payload does not have the expected shape', () => {
    for (const bad of [
      '{"unexpected":true}',
      '<html>error page</html>',
      '{"statusItemsRenamed":[]}',
      '',
      null,
      undefined,
    ]) {
      expect(parse(bad).severity).toBe(SEVERITY.UNKNOWN);
    }
  });

  it('handles nested objects inside an incident without mis-slicing', () => {
    // These objects nest (children, crnMasks), which is why the extractor walks
    // braces rather than using a regex.
    const r = parse(
      doc([
        {
          type: 'incident',
          state: 'investigating',
          sev: 2,
          name: 'Nested',
          children: [{ id: 'c1', nested: { deep: true } }],
          resourceIDs: ['is-vpc'],
        },
      ]),
    );
    expect(r.severity).toBe(SEVERITY.PARTIAL_OUTAGE);
    expect(r.components).toHaveLength(1);
  });
});

describe('ibm lists its full service catalogue', () => {
  // Reported 2026-08-01: "I don't see all the separate services for IBM
  // Cloud". With no active incidents the row had zero components, so a reader
  // could not see what IBM Cloud even covers — the same complaint raised about
  // Oracle. The payload carries a `resources` catalogue of 166 services.
  const cat = (services, incidents = []) =>
    JSON.stringify({
      statusItems: incidents,
      resources: services.map(([resourceID, displayName]) => ({ resourceID, displayName, regions: [] })),
    });

  it('reports every catalogued service, healthy ones included', () => {
    const r = parse(cat([['is-vpc', 'Virtual Private Cloud'], ['cloudshell', 'IBM Cloud Shell']]));
    expect(r.components.map((c) => c.name).sort()).toEqual(['IBM Cloud Shell', 'Virtual Private Cloud']);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('marks only the services an active incident names', () => {
    const r = parse(
      cat(
        [['is-vpc', 'Virtual Private Cloud'], ['cloudshell', 'IBM Cloud Shell']],
        [{ type: 'incident', state: 'investigating', sev: 1, name: 'VPC down', resourceIDs: ['is-vpc'] }],
      ),
    );
    const vpc = r.components.find((c) => c.name === 'Virtual Private Cloud');
    const shell = r.components.find((c) => c.name === 'IBM Cloud Shell');
    expect(vpc.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(shell.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('sorts affected services above healthy ones', () => {
    const r = parse(
      cat(
        [['aaa-healthy', 'AAA Healthy'], ['zzz-broken', 'ZZZ Broken']],
        [{ type: 'incident', state: 'investigating', sev: 1, name: 'X', resourceIDs: ['zzz-broken'] }],
      ),
    );
    expect(r.components[0].name).toBe('ZZZ Broken');
  });

  it('still surfaces an incident naming a resource missing from the catalogue', () => {
    // Otherwise a real outage would vanish because of a catalogue gap.
    const r = parse(
      cat(
        [['is-vpc', 'Virtual Private Cloud']],
        [{ type: 'incident', state: 'investigating', sev: 1, name: 'Mystery', resourceIDs: ['not-in-catalogue'] }],
      ),
    );
    expect(r.components.map((c) => c.name)).toContain('not-in-catalogue');
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('falls back to the resourceID when a service has no display name', () => {
    const r = parse(cat([['ngdc-network-underlay', '']]));
    expect(r.components[0].name).toBe('ngdc-network-underlay');
  });

  it('is stable across repeated calls', () => {
    // CATALOGUE_RE is a global regex; leaving lastIndex set would make the
    // SECOND collection of the day return no services at all.
    const doc = cat([['is-vpc', 'Virtual Private Cloud'], ['cloudshell', 'IBM Cloud Shell']]);
    expect(parse(doc).components.length).toBe(parse(doc).components.length);
    expect(parse(doc).components.length).toBe(2);
  });
});
