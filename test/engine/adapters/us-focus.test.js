import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStatuspage } from '../../../src/engine/adapters/statuspage.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// The board judges severity from a US vantage point (operator decision,
// 2026-08-03): for vendors publishing per-region status, the row's severity
// comes from the scoped US components only, while non-US trouble stays
// visible as card detail that informs without voting.
//
// Mechanically this means scope and componentLevel:'group' must COMPOSE —
// scope picks the leaves that decide severity, group mode keeps deciding
// what the card displays. Before this change group mode bypassed scope, so
// a UAE-only outage read as a global major_outage (captured live in the
// fixture: US East / Virginia healthy, Middle East / UAE hard down).

const payload = JSON.parse(
  readFileSync(new URL('../../fixtures/OutSystems-regional-outage.json', import.meta.url), 'utf8'),
);
const now = () => new Date('2026-08-03T13:00:00Z');

describe('scope composes with group mode: US leaves vote, groups display', () => {
  const r = parseStatuspage(payload, {
    vendor: 'OutSystems',
    componentLevel: 'group',
    scope: { components: ['US East / Virginia'] },
    now,
  });

  it('row severity comes from the scoped US leaves only', () => {
    // In the fixture every US East / Virginia leaf is operational while UAE
    // is major_outage — under US focus this row is operational.
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('the card still shows groups, with non-US trouble as detail', () => {
    const odc = r.components.find((c) => c.name === 'ODC - Customer Apps & Data');
    expect(odc.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(odc.description).toContain('Middle East / UAE');
  });

  it('a scoped name that vanishes from the payload still warns', () => {
    const gone = parseStatuspage(payload, {
      vendor: 'OutSystems',
      componentLevel: 'group',
      scope: { components: ['US East / Nowhere'] },
      now,
    });
    expect(gone.warnings.join(' ')).toMatch(/matched no component/);
    // And with nothing in scope verified, the row must fail closed.
    expect(gone.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('without a scope, group mode behaves exactly as before', () => {
    const unscoped = parseStatuspage(payload, { vendor: 'OutSystems', componentLevel: 'group', now });
    expect(unscoped.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });
});
