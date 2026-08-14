import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseInstatus } from '../../../src/engine/adapters/instatus.js';
import { SEVERITY } from '../../../src/engine/severity.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`../../fixtures/${n}.json`, import.meta.url), 'utf8'));
const now = () => new Date('2026-07-30T12:00:00Z');

describe('instatus (perplexity)', () => {
  it('reports operational from a real all-clear payload', () => {
    const r = parseInstatus(fixture('Perplexity-instatus'), { vendor: 'Perplexity', now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('exposes components as children for roll-up', () => {
    const r = parseInstatus(fixture('Perplexity-instatus'), { vendor: 'Perplexity', now });
    expect(r.components.map((c) => c.name)).toEqual(expect.arrayContaining(['API', 'Website']));
  });

  it('maps the Instatus component vocabulary, which differs from Statuspage', () => {
    const payload = {
      page: { status: 'HASISSUES', url: 'https://x' },
      components: [
        { name: 'API', status: 'MAJOROUTAGE', isParent: false },
        { name: 'Website', status: 'OPERATIONAL', isParent: false },
      ],
    };
    const r = parseInstatus(payload, { vendor: 'V', now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('ignores isParent container rows so a parent does not double-count', () => {
    const payload = {
      page: { status: 'UP' },
      components: [
        { name: 'Group', status: 'OPERATIONAL', isParent: true },
        { name: 'Child', status: 'OPERATIONAL', isParent: false },
      ],
    };
    expect(parseInstatus(payload, { vendor: 'V', now }).components).toHaveLength(1);
  });

  it('fails closed on an unrecognisable payload', () => {
    expect(parseInstatus(null, { vendor: 'V', now }).severity).toBe(SEVERITY.UNKNOWN);
    expect(parseInstatus({}, { vendor: 'V', now }).severity).toBe(SEVERITY.UNKNOWN);
  });
});

describe('instatus (coalition control)', () => {
  // status.coalitioninc.com monitors ONLY the Coalition Control platform (API
  // + Web). Coalition's incident-response / MDR / SOC services publish no
  // health endpoint anywhere, so the row is labelled "Coalition (Control)" —
  // the Microsoft (Consumer Services) precedent: name what is verified, not
  // the whole company.
  it('reports operational from a real all-clear payload', () => {
    const r = parseInstatus(fixture('Coalition-instatus'), { vendor: 'Coalition (Control)', now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('exposes both Control components for roll-up', () => {
    const r = parseInstatus(fixture('Coalition-instatus'), { vendor: 'Coalition (Control)', now });
    expect(r.components.map((c) => c.name)).toEqual(['Control API', 'Control Web']);
  });
});
