import { describe, it, expect } from 'vitest';
import { parseConcurStatus, concurSeverityOf, isReadableConcurDoc } from '../../../src/engine/adapters/concur-status.js';
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

// Worklist #132. The collector tells the adapter which data centres it could
// not read; the adapter shows them, keeps them out of the vote, and refuses to
// judge the row at all when a required one is missing.
describe('parseConcurStatus — a status word it does not know', () => {
  it('fails closed AND says so, so an Unknown card is never unexplained', () => {
    const r = parseConcurStatus([doc({ Expense: 'wobbly', Travel: 'normal' })], { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings).toEqual(['unrecognised status "wobbly" on "Expense"']);
  });
});

describe('parseConcurStatus — data centres that could not be read', () => {
  it('shows each as an unknown component, after the services, and does not let it vote', () => {
    const r = parseConcurStatus([doc({ Expense: 'normal', Travel: 'normal' })], {
      vendor: 'Concur',
      dataCenters: ['US2'],
      unreadDataCenters: ['EU2', 'USG'],
      now,
    });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components.map((c) => [c.name, c.severity])).toEqual([
      ['Expense', SEVERITY.OPERATIONAL],
      ['Travel', SEVERITY.OPERATIONAL],
      ['Data centre EU2', SEVERITY.UNKNOWN],
      ['Data centre USG', SEVERITY.UNKNOWN],
    ]);
    expect(r.description).toBe('All 2 services report normal.'); // counts services, not data centres
    expect(r.warnings).toEqual([]); // the note on the card is the collector's
  });

  it.each([
    ['upper case in config, lower from the collector', ['US2'], ['us2']],
    ['lower case in config, upper from the collector', ['us2'], ['US2']],
  ])('a REQUIRED data centre among them is an unknown vote: never green from the others (%s)', (_label, dataCenters, unreadDataCenters) => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], { vendor: 'Concur', dataCenters, unreadDataCenters, now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.description).toBe('Status could not be determined.');
    expect(r.incidentName).toBe('');
    expect(r.warnings).toEqual([`Concur's ${unreadDataCenters[0]} data centre could not be read, so its status is not shown.`]);
    // What was read is still listed, under the data centre that was not.
    expect(r.components.map((c) => [c.name, c.severity])).toEqual([
      ['Expense', SEVERITY.OPERATIONAL],
      [`Data centre ${unreadDataCenters[0]}`, SEVERITY.UNKNOWN],
    ]);
  });

  it('a required data centre unread does not hide trouble verified in another: worst wins, as everywhere else', () => {
    const r = parseConcurStatus([doc({ Expense: 'unavailable', Travel: 'normal' })], {
      vendor: 'Concur', dataCenters: ['US2'], unreadDataCenters: ['US2'], now,
    });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.description).toBe('Affected: Expense.');
    expect(r.warnings).toEqual([]); // the row has a status; the collector's note names US2
  });

  it('a required data centre unread and maintenance elsewhere: unknown outranks maintenance, and the row says only that', () => {
    const r = parseConcurStatus([doc({ Expense: 'maintenance' })], { vendor: 'Concur', dataCenters: ['US2'], unreadDataCenters: ['US2'], now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings).toHaveLength(1);
    // Not "Service issue / Affected: Expense." under an Unknown badge.
    expect(r.incidentName).toBe('');
    expect(r.description).toBe('Status could not be determined.');
    expect(r.components.find((c) => c.name === 'Expense').severity).toBe(SEVERITY.MAINTENANCE); // still listed
  });

  it("a required data centre unread and the banner displayed: degraded, in the banner's words", () => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], {
      vendor: 'Concur', dataCenters: ['US2'], unreadDataCenters: ['US2'], banner: { data: { display: true, text: { en: 'Issue Alert' } } }, now,
    });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.incidentName).toBe('Status banner displayed');
    expect(r.description).toBe('Issue Alert');
    expect(r.warnings).toEqual([]);
  });

  it('documents that hold no service, with a required data centre unread, say which', () => {
    const r = parseConcurStatus([{ data: {} }], { vendor: 'Concur', dataCenters: ['US2'], unreadDataCenters: ['US2'], now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings).toEqual(["Concur's US2 data centre could not be read, so its status is not shown."]);
  });

  it('two required data centres unread are both named', () => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], { vendor: 'Concur', dataCenters: ['US2', 'USG'], unreadDataCenters: ['US2', 'USG'], now });
    expect(r.warnings).toEqual(["Concur's US2 and USG data centres could not be read, so its status is not shown."]);
  });

  it('nothing read at all, with a required data centre unread, says which', () => {
    const r = parseConcurStatus([], { vendor: 'Concur', dataCenters: ['US2'], unreadDataCenters: ['US2', 'EU2'], now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings).toEqual(["Concur's US2 data centre could not be read, so its status is not shown."]);
  });

  it('with no required data centre configured, a missing one never makes the row unknown by itself', () => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], { vendor: 'Concur', unreadDataCenters: ['US2'], now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('still keeps trouble that was read', () => {
    const r = parseConcurStatus([doc({ Expense: 'unavailable' })], { vendor: 'Concur', dataCenters: ['US2'], unreadDataCenters: ['APJ1'], now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });
});

describe('isReadableConcurDoc — what counts as a reading of one data centre', () => {
  it.each([
    ['a service with a Current Status', doc({ Expense: 'normal' }), true],
    ['a status word we do not know (the adapter fails closed on it; it is still a reading)', doc({ Expense: 'fine' }), true],
    ['no data at all', { success: true }, false],
    ['data that is not an object', { data: 'nope' }, false],
    ['an empty data object', { data: {} }, false],
    ['services, none with a Current Status', { data: { Expense: { Service: 'Expense' } } }, false],
    ['null', null, false],
    ['a string', 'not json shaped', false],
  ])('%s -> %s', (_label, input, expected) => {
    expect(isReadableConcurDoc(input)).toBe(expected);
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

  it("shows the banner in Concur's own words when it carries English text", () => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], {
      vendor: 'Concur',
      banner: { data: { display: true, text: { en: 'Issue Alert – We are <b>investigating</b> an issue.', de: 'Problemwarnung' } } },
      now,
    });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.description).toBe('Issue Alert – We are investigating an issue.');
  });

  it('trouble in a service and a displayed banner: the card names both', () => {
    // Maintenance plus a banner reads Degraded. Without the banner's text
    // nothing on the card would say why.
    const r = parseConcurStatus([doc({ Expense: 'maintenance' })], {
      vendor: 'Concur', banner: { data: { display: true, text: { en: 'Issue Alert' } } }, now,
    });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.incidentName).toBe('Service issue');
    expect(r.description).toBe('Affected: Expense. Issue Alert');
  });

  it('a very long banner is cut, and a pathological one costs nothing', () => {
    const long = parseConcurStatus([doc({ Expense: 'normal' })], { vendor: 'Concur', banner: { data: { display: true, text: { en: 'word '.repeat(2000) } } }, now });
    expect(long.description.length).toBeLessThanOrEqual(300);
    const started = Date.now();
    const odd = parseConcurStatus([doc({ Expense: 'normal' })], { vendor: 'Concur', banner: { data: { display: true, text: { en: '<'.repeat(60_000) } } }, now });
    expect(Date.now() - started).toBeLessThan(100);
    expect(odd.severity).toBe(SEVERITY.DEGRADED);
  });

  it.each([
    ['text that is not a string', { en: 42 }],
    ['empty text', { en: '   ' }],
    ['no text at all', undefined],
  ])('falls back to its own sentence on %s', (_label, text) => {
    const r = parseConcurStatus([doc({ Expense: 'normal' })], { vendor: 'Concur', banner: { data: { display: true, text } }, now });
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
