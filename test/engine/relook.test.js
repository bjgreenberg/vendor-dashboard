import { describe, it, expect } from 'vitest';
import { relookCandidates, classifyRelook } from '../../src/engine/relook.js';
import { SEVERITY } from '../../src/engine/severity.js';

// The re-look policy, tested with no Worker, no clock and no database.
// Worklist #129: a run looks again at the vendors whose fetch failed, and a
// re-look may only IMPROVE a row.

const v = (name, over = {}) => ({ name, type: 'statuspage', url: `https://${name}`, ...over });
const rec = (vendor, severity) => ({ vendor, severity });
const run = (records, { waitable = [], incomplete = [], usedExtraDocuments = [] } = {}) => ({ records, waitable, incomplete, usedExtraDocuments });

describe('relookCandidates — who may be looked at again', () => {
  it('keeps plain vendors and composites of plain sources', () => {
    const plain = v('Plain');
    const multi = { name: 'Multi', type: 'composite', sources: [v('a'), v('b')] };
    expect(relookCandidates([plain, multi])).toEqual([plain, multi]);
  });

  it('drops every vendor configured to read more than one document', () => {
    const concur = { name: 'Concur', type: 'concur-status', url: 'https://c', statusUrls: ['https://c'] };
    const zscaler = { name: 'Zscaler', type: 'zscaler', url: 'https://z', clouds: [] };
    const docusign = { name: 'Docusign', type: 'docusign', url: 'https://d', incidentsUrl: 'https://i' };
    const iorad = { name: 'Iorad', type: 'sorryapp', url: 'https://s', componentsUrl: 'https://c' };
    const google = { name: 'Google', type: 'google', url: 'https://g', componentsUrl: 'https://p' };
    const plain = v('Plain');
    expect(relookCandidates([concur, plain, zscaler, docusign, iorad, google])).toEqual([plain]);
  });
});

describe('classifyRelook — what one re-look found', () => {
  it('a vendor read in full with a real status is recovered', () => {
    const a = v('A');
    expect(classifyRelook(run([rec('A', SEVERITY.OPERATIONAL)]), [a])).toEqual({
      recovered: [rec('A', SEVERITY.OPERATIONAL)],
      stillFailing: [],
      gaveUp: [],
    });
  });

  it('a recovered vendor may be in trouble: recovered means read, not healthy', () => {
    const out = classifyRelook(run([rec('A', SEVERITY.MAJOR_OUTAGE)]), [v('A')]);
    expect(out.recovered).toEqual([rec('A', SEVERITY.MAJOR_OUTAGE)]);
  });

  it('a vendor still failing waitably is still failing, and nothing is written for it', () => {
    const a = v('A');
    expect(classifyRelook(run([rec('A', SEVERITY.UNKNOWN)], { waitable: ['A'], incomplete: ['A'] }), [a])).toEqual({
      recovered: [],
      stillFailing: [a],
      gaveUp: [],
    });
  });

  it('a vendor not read in full for a reason waiting cannot fix is given up on', () => {
    const a = v('A');
    expect(classifyRelook(run([rec('A', SEVERITY.UNKNOWN)], { incomplete: ['A'] }), [a])).toEqual({
      recovered: [],
      stillFailing: [],
      gaveUp: [a],
    });
  });

  it('a partial reading is never recovered, whatever its severity says', () => {
    // A composite whose row reads "degraded" from three sources and nothing
    // from the fourth. Degraded outranks unknown, so the severity alone looks
    // like a status; `incomplete` is what says a source went unread.
    const m = v('Multi');
    const waitablePartial = classifyRelook(run([rec('Multi', SEVERITY.DEGRADED)], { waitable: ['Multi'], incomplete: ['Multi'] }), [m]);
    expect(waitablePartial).toEqual({ recovered: [], stillFailing: [m], gaveUp: [] });
    const deadPartial = classifyRelook(run([rec('Multi', SEVERITY.DEGRADED)], { incomplete: ['Multi'] }), [m]);
    expect(deadPartial).toEqual({ recovered: [], stillFailing: [], gaveUp: [m] });
  });

  it('never recovers a vendor that read an extra document, however whole the reading looks', () => {
    // Fail closed. An extra document can answer 200 and be empty; the adapter
    // then reads from the first document alone and nothing says so. Whatever
    // a vendor's config looks like, and whichever adapter gains an extra
    // document next, a re-look does not write it.
    const a = v('A');
    const out = classifyRelook(run([rec('A', SEVERITY.OPERATIONAL)], { usedExtraDocuments: ['A'] }), [a]);
    expect(out).toEqual({ recovered: [], stillFailing: [], gaveUp: [a] });
  });

  it('never recovers an unknown row, even if `incomplete` fails to list it', () => {
    // Belt and braces: a missing or misnamed `incomplete` must not let an
    // unknown row be written.
    const out = classifyRelook(run([rec('A', SEVERITY.UNKNOWN)], { incomplete: [] }), [v('A')]);
    expect(out.recovered).toEqual([]);
    expect(out.gaveUp.map((x) => x.name)).toEqual(['A']);
  });

  it('sorts a mixed batch, each vendor into exactly one list', () => {
    const [a, b, c] = [v('A'), v('B'), v('C')];
    const out = classifyRelook(
      run([rec('A', SEVERITY.OPERATIONAL), rec('B', SEVERITY.UNKNOWN), rec('C', SEVERITY.UNKNOWN)], {
        waitable: ['B'],
        incomplete: ['B', 'C'],
      }),
      [a, b, c],
    );
    expect(out.recovered.map((r) => r.vendor)).toEqual(['A']);
    expect(out.stillFailing).toEqual([b]);
    expect(out.gaveUp).toEqual([c]);
  });
});
