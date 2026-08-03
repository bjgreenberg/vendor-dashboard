import { describe, it, expect } from 'vitest';
import { parseConcurStatus, concurSeverityOf } from '../../../src/engine/adapters/concur-status.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Audit finding M4: this adapter sat at 16.66% branch coverage inside a
// passing blended gate — and it is the NEWEST parser, written mid-incident on
// 2026-08-01. The branches below are the ones that decide whether Concur can
// read falsely green: the per-DC merge, worst-wins, the banner floor, and the
// fail-closed paths.

const now = () => new Date('2026-08-01T12:00:00Z');

/** One status_history document, service -> current status string. */
const doc = (services) => ({
  data: Object.fromEntries(
    Object.entries(services).map(([name, status]) => [
      name,
      { Service: name, 'Current Status': { status, incidents: [] } },
    ]),
  ),
});

describe('concurSeverityOf — vocabulary, fail closed', () => {
  it('maps the documented vocabulary', () => {
    expect(concurSeverityOf('normal')).toBe(SEVERITY.OPERATIONAL);
    expect(concurSeverityOf('degradation')).toBe(SEVERITY.DEGRADED);
    expect(concurSeverityOf('unavailable')).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(concurSeverityOf('maintenance')).toBe(SEVERITY.MAINTENANCE);
  });

  it('strips case and punctuation before matching', () => {
    expect(concurSeverityOf('Normal.')).toBe(SEVERITY.OPERATIONAL);
    expect(concurSeverityOf('De-Graded')).toBe(SEVERITY.DEGRADED);
  });

  it('fails closed on anything unrecognised, empty, or nullish', () => {
    expect(concurSeverityOf('fine')).toBe(SEVERITY.UNKNOWN);
    expect(concurSeverityOf('')).toBe(SEVERITY.UNKNOWN);
    expect(concurSeverityOf(null)).toBe(SEVERITY.UNKNOWN);
    expect(concurSeverityOf(undefined)).toBe(SEVERITY.UNKNOWN);
    // The prototype-pollution trap severity.js documents: a status string that
    // names an Object.prototype member must not resolve to a function.
    expect(concurSeverityOf('toString')).toBe(SEVERITY.UNKNOWN);
  });
});

describe('parseConcurStatus — per-data-centre merge', () => {
  it('reports operational when every service in every DC is normal', () => {
    const r = parseConcurStatus([doc({ Expense: 'normal', Travel: 'normal' })], { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components.map((c) => c.name).sort()).toEqual(['Expense', 'Travel']);
    expect(r.description).toBe('All 2 services report normal.');
  });

  it('merges worst-wins across data centres — one healthy DC cannot mask a broken one', () => {
    // The false green this adapter exists to prevent: us2 healthy while EU is
    // down must read as down.
    const us2 = doc({ Expense: 'normal' });
    const eu = doc({ Expense: 'unavailable' });
    const r = parseConcurStatus([us2, eu], { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components).toEqual([{ name: 'Expense', severity: SEVERITY.MAJOR_OUTAGE, description: '' }]);
    expect(r.description).toBe('Affected: Expense.');
  });

  it('sorts components most-severe first, then alphabetically', () => {
    const r = parseConcurStatus(
      [doc({ Zeta: 'normal', Alpha: 'normal', Mid: 'degraded' })],
      { vendor: 'Concur', now },
    );
    expect(r.components.map((c) => c.name)).toEqual(['Mid', 'Alpha', 'Zeta']);
  });

  it('an unrecognised status surfaces as unknown, never operational', () => {
    const r = parseConcurStatus([doc({ Expense: 'sparkling' })], { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('accepts a single document not wrapped in an array', () => {
    const r = parseConcurStatus(doc({ Expense: 'normal' }), { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('skips entries with no Current Status rather than inventing one', () => {
    const payload = { data: { Ghost: { Service: 'Ghost' }, Real: { Service: 'Real', 'Current Status': { status: 'normal' } } } };
    const r = parseConcurStatus([payload], { vendor: 'Concur', now });
    expect(r.components.map((c) => c.name)).toEqual(['Real']);
  });
});

describe('parseConcurStatus — fail-closed paths', () => {
  it.each([
    ['null payload', null],
    ['empty array', []],
    ['docs without data', [{ nope: true }]],
    ['string payload', 'not json shaped'],
  ])('returns unknown on %s', (_label, payload) => {
    const r = parseConcurStatus(payload, { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('returns unknown when documents parse but carry no services', () => {
    const r = parseConcurStatus([{ data: {} }], { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings[0]).toMatch(/no services/);
  });
});

describe('parseConcurStatus — banner floor', () => {
  it('an active banner floors an otherwise-green board at degraded', () => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], {
      vendor: 'Concur',
      banner: { data: { display: true } },
      now,
    });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.incidentName).toBe('Status banner displayed');
    expect(r.description).toBe('Concur is displaying a status banner.');
  });

  it('a worse component severity is not diluted by the banner floor', () => {
    const r = parseConcurStatus([doc({ Expense: 'unavailable' })], {
      vendor: 'Concur',
      banner: { data: { display: true } },
      now,
    });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('an inactive banner adds nothing', () => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], {
      vendor: 'Concur',
      banner: { data: { display: false } },
      now,
    });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });
});
