import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStatuspage } from '../../../src/engine/adapters/statuspage.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Captured live 2026-08-03: OutSystems with Middle East / UAE hard down for
// the three ODC groups and Europe / Frankfurt degraded, while the ONLY posted
// incident was a minor monitoring-stage Frankfurt note. In group mode the
// board showed an unexplained global "Major outage": Statuspage rolls a
// group's status to its worst regional child, and the regional leaves — the
// only place the story lives — were exactly what group mode discards.
//
// The contract: a group-mode component that is not operational names the
// regions driving its status, so a reader can tell one broken region from a
// global outage without leaving the board.

const payload = JSON.parse(
  readFileSync(new URL('../../fixtures/OutSystems-regional-outage.json', import.meta.url), 'utf8'),
);
const now = () => new Date('2026-08-03T13:00:00Z');

describe('group-mode components carry their unhealthy regions', () => {
  const r = parseStatuspage(payload, {
    vendor: 'OutSystems',
    componentLevel: 'group',
    now,
  });

  it('sanity: the fixture reproduces the reported state', () => {
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components.filter((c) => c.severity === SEVERITY.MAJOR_OUTAGE)).toHaveLength(3);
  });

  it('a broken group names the regions driving its status', () => {
    const odc = r.components.find((c) => c.name === 'ODC - Customer Apps & Data');
    expect(odc.description).toContain('Middle East / UAE');
    expect(odc.description).toMatch(/major outage/i);
  });

  it('a degraded region shows with its own state, not the group headline', () => {
    const odc = r.components.find((c) => c.name === 'ODC - Customer Apps & Data');
    expect(odc.description).toContain('Europe / Frankfurt');
    expect(odc.description).toMatch(/degraded/i);
  });

  it('healthy groups carry no description, so the board stays quiet', () => {
    const mentor = r.components.find((c) => c.name === 'Mentor');
    expect(mentor.severity).toBe(SEVERITY.OPERATIONAL);
    expect(mentor.description ?? '').toBe('');
  });
});
