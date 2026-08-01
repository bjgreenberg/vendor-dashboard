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

/** Build a payload with the given incidents, in the minified real shape. */
const doc = (incidents) =>
  JSON.stringify({
    statusItems: incidents,
    resources: [{ resourceID: 'is-vpc' }],
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

  it('reports an ACTIVE incident and names the affected resource', () => {
    const r = parse(
      doc([{ type: 'incident', state: 'investigating', sev: 1, name: 'VPC disruption', resourceIDs: ['is-vpc'] }]),
    );
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components[0].name).toContain('is-vpc');
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
