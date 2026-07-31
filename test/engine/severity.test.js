import { describe, it, expect } from 'vitest';
import { SEVERITY, rank, normalizeSeverity, worst, compareRecords } from '../../src/engine/severity.js';

// Audit finding M1: the Apps Script collapsed every vendor state to a binary
// Operational|Degraded, discarding the gradations Statuspage supplies for free.
// That is why a total outage and a minor blip rendered identically, and why
// "sort by down first" was not implementable.

describe('severity ordering', () => {
  it('ranks a total outage as more severe than a partial one', () => {
    expect(rank(SEVERITY.MAJOR_OUTAGE)).toBeGreaterThan(rank(SEVERITY.PARTIAL_OUTAGE));
  });

  it('ranks any real problem as more severe than operational', () => {
    for (const s of [SEVERITY.MAJOR_OUTAGE, SEVERITY.PARTIAL_OUTAGE, SEVERITY.DEGRADED, SEVERITY.MAINTENANCE]) {
      expect(rank(s)).toBeGreaterThan(rank(SEVERITY.OPERATIONAL));
    }
  });

  // Audit finding H4: a failed check must never be indistinguishable from health.
  it('ranks unknown above operational so a failed check can never read as green', () => {
    expect(rank(SEVERITY.UNKNOWN)).toBeGreaterThan(rank(SEVERITY.OPERATIONAL));
  });

  it('ranks unknown below a confirmed outage, since it is uncertainty not failure', () => {
    expect(rank(SEVERITY.UNKNOWN)).toBeLessThan(rank(SEVERITY.MAJOR_OUTAGE));
  });
});

describe('normalizeSeverity', () => {
  it('maps Statuspage component vocabulary onto the enum', () => {
    expect(normalizeSeverity('major_outage')).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(normalizeSeverity('partial_outage')).toBe(SEVERITY.PARTIAL_OUTAGE);
    expect(normalizeSeverity('degraded_performance')).toBe(SEVERITY.DEGRADED);
    expect(normalizeSeverity('under_maintenance')).toBe(SEVERITY.MAINTENANCE);
    expect(normalizeSeverity('operational')).toBe(SEVERITY.OPERATIONAL);
  });

  it('maps Statuspage page-level indicators onto the enum', () => {
    expect(normalizeSeverity('critical')).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(normalizeSeverity('major')).toBe(SEVERITY.PARTIAL_OUTAGE);
    expect(normalizeSeverity('minor')).toBe(SEVERITY.DEGRADED);
    expect(normalizeSeverity('none')).toBe(SEVERITY.OPERATIONAL);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeSeverity('  Major_Outage ')).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  // Fail closed: an unrecognised vendor string is uncertainty, never health.
  it('maps an unrecognised value to UNKNOWN, never to OPERATIONAL', () => {
    expect(normalizeSeverity('bananas')).toBe(SEVERITY.UNKNOWN);
    expect(normalizeSeverity('')).toBe(SEVERITY.UNKNOWN);
    expect(normalizeSeverity(null)).toBe(SEVERITY.UNKNOWN);
    expect(normalizeSeverity(undefined)).toBe(SEVERITY.UNKNOWN);
  });
});

describe('worst', () => {
  it('returns the most severe of a set', () => {
    expect(worst([SEVERITY.OPERATIONAL, SEVERITY.MAJOR_OUTAGE, SEVERITY.DEGRADED])).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('returns OPERATIONAL for an empty set', () => {
    expect(worst([])).toBe(SEVERITY.OPERATIONAL);
  });
});

describe('compareRecords — the requested sort', () => {
  const rec = (vendor, severity) => ({ vendor, severity });

  it('sorts most severe first', () => {
    const sorted = [rec('A', SEVERITY.OPERATIONAL), rec('B', SEVERITY.MAJOR_OUTAGE)].sort(compareRecords);
    expect(sorted.map((r) => r.vendor)).toEqual(['B', 'A']);
  });

  it('sorts alphabetically within the same severity', () => {
    const sorted = [rec('Zoom', SEVERITY.DEGRADED), rec('Apple', SEVERITY.DEGRADED)].sort(compareRecords);
    expect(sorted.map((r) => r.vendor)).toEqual(['Apple', 'Zoom']);
  });

  it('is case-insensitive when comparing vendor names', () => {
    const sorted = [rec('zapier', SEVERITY.OPERATIONAL), rec('Apple', SEVERITY.OPERATIONAL)].sort(compareRecords);
    expect(sorted.map((r) => r.vendor)).toEqual(['Apple', 'zapier']);
  });

  it('puts a full outage, then a blip, then unknown, then healthy — in that order', () => {
    const sorted = [
      rec('Healthy', SEVERITY.OPERATIONAL),
      rec('Unknown', SEVERITY.UNKNOWN),
      rec('Blip', SEVERITY.DEGRADED),
      rec('Outage', SEVERITY.MAJOR_OUTAGE),
    ].sort(compareRecords);
    expect(sorted.map((r) => r.vendor)).toEqual(['Outage', 'Blip', 'Unknown', 'Healthy']);
  });
});
