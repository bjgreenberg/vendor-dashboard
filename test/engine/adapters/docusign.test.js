import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDocusign } from '../../../src/engine/adapters/docusign.js';
import { SEVERITY } from '../../../src/engine/severity.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`../../fixtures/${n}.json`, import.meta.url), 'utf8'));
const now = () => new Date('2026-09-02T04:00:00Z');
const opts = (extra = {}) => ({ vendor: 'Docusign', sourceUrl: 'https://health.docusign.com/status', now, ...extra });

/** Find a component by name in a components.json payload. */
const byName = (payload, name) => payload.components.find((c) => c.name === name);

describe('docusign (health.docusign.com components + incidents feeds)', () => {
  it('reports operational from the real all-clear capture', () => {
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: fixture('Docusign-incidents') }));
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.warnings).toEqual([]);
    expect(r.incidentName).toBe('');
    expect(r.sourceUrl).toBe('https://health.docusign.com/status');
    expect(r.checkedAt).toBe('2026-09-02T04:00:00.000Z');
  });

  it('displays the six top-level products, not the 68 per-datacentre sites', () => {
    const r = parseDocusign(fixture('Docusign-components'), opts());
    expect(r.components.map((c) => c.name)).toEqual([
      'CLM',
      'eSignature',
      'IAM Features',
      'Insight',
      'Rooms',
      'Trusted Service Provider',
    ]);
    expect(r.components.every((c) => c.severity === SEVERITY.OPERATIONAL)).toBe(true);
  });

  it('rolls a degraded leaf up to its product and to the row', () => {
    const payload = structuredClone(fixture('Docusign-components'));
    byName(payload, 'NA1').status = 'performance_degradation';
    const r = parseDocusign(payload, opts());
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.components.find((c) => c.name === 'eSignature').severity).toBe(SEVERITY.DEGRADED);
    expect(r.components.find((c) => c.name === 'CLM').severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('rolls a service_disruption two levels deep (site under a nested product) up to the group', () => {
    const payload = structuredClone(fixture('Docusign-components'));
    // Agreement Desk is a product nested under the IAM Features group.
    const desk = byName(payload, 'Agreement Desk');
    byName(payload, 'IAM Features').children.includes(desk.id) || expect.fail('fixture shape changed');
    payload.components.find((c) => c.id === desk.children[0]).status = 'service_disruption';
    const r = parseDocusign(payload, opts());
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components.find((c) => c.name === 'IAM Features').severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('a child shared by two parents (a DAG) votes for BOTH parents, not just the first visited', () => {
    // Copilot review on PR #130: a single visited-set returned the second
    // parent green when a shared child was already counted under the first.
    const payload = {
      components: [
        { id: 'p1', name: 'P1', type: 'product', parentId: null, status: 'available', children: ['shared'] },
        { id: 'p2', name: 'P2', type: 'product', parentId: null, status: 'available', children: ['shared'] },
        { id: 'shared', name: 'Shared', type: 'site', parentId: 'p1', status: 'service_disruption', children: [] },
        { id: 's2', name: 'S2', type: 'site', parentId: 'p2', status: 'available', children: [] },
      ],
    };
    const r = parseDocusign(payload, opts());
    expect(r.components.find((c) => c.name === 'P1').severity).toBe(SEVERITY.MAJOR_OUTAGE);
    // parentId names p1, but p2 lists the same child too — it must count there as well.
    expect(r.components.find((c) => c.name === 'P2').severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('a cycle in the tree fails closed to unknown with a warning, never green', () => {
    const payload = {
      components: [
        { id: 'a', name: 'A', type: 'product', parentId: null, status: 'available', children: ['b'] },
        { id: 'b', name: 'B', type: 'product', parentId: 'a', status: 'available', children: ['a'] },
      ],
    };
    const r = parseDocusign(payload, opts());
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/cycle/i);
  });

  it('a cycle beneath a healthy root still fails that root closed', () => {
    const payload = {
      components: [
        { id: 'root', name: 'Root', type: 'product', parentId: null, status: 'available', children: ['b'] },
        { id: 'b', name: 'B', type: 'product', parentId: 'root', status: 'available', children: ['c'] },
        { id: 'c', name: 'C', type: 'site', parentId: 'b', status: 'available', children: ['b'] },
        { id: 'other', name: 'Other', type: 'product', parentId: null, status: 'available', children: [] },
      ],
    };
    const r = parseDocusign(payload, opts());
    expect(r.components.find((c) => c.name === 'Root').severity).toBe(SEVERITY.UNKNOWN);
    expect(r.components.find((c) => c.name === 'Other').severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/cycle through "B"/);
  });

  it('fails closed on a status word it has never seen', () => {
    const payload = structuredClone(fixture('Docusign-components'));
    byName(payload, 'NA1').status = 'partially_available';
    const r = parseDocusign(payload, opts());
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/partially_available/);
  });

  it('fails closed when the payload is not a components document', () => {
    for (const bad of [null, 'html', {}, { components: [] }, { components: 'nope' }]) {
      const r = parseDocusign(bad, opts());
      expect(r.severity, JSON.stringify(bad)).toBe(SEVERITY.UNKNOWN);
      expect(r.warnings.length, JSON.stringify(bad)).toBeGreaterThan(0);
      expect(r.components).toEqual([]);
    }
  });

  it('never reports operational from a component list where nothing carries a status', () => {
    const r = parseDocusign({ components: [{ id: 'a', name: 'X', type: 'product', parentId: null, children: [] }] }, opts());
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('surfaces an active incident: impact votes, title and latest update describe the row', () => {
    const incidents = structuredClone(fixture('Docusign-incidents'));
    const active = incidents.incidents[0];
    active.status = 'identified';
    active.resolvedAt = null;
    active.events = [
      { body: 'We have identified the cause.', status: 'identified', displayAt: '2026-09-02T03:50:00Z' },
      { body: '<p>We are <b>investigating</b> latency.</p>', status: 'investigating', displayAt: '2026-09-02T03:40:00Z' },
    ];
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents }));
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.incidentName).toBe('UI Latency Issues (Incident 5692)');
    expect(r.description).toBe('We have identified the cause.');
  });

  it('picks the latest update by displayAt, not by array position', () => {
    const incidents = structuredClone(fixture('Docusign-incidents'));
    const active = incidents.incidents[0];
    active.status = 'monitoring';
    active.events = [
      { body: 'older', status: 'investigating', displayAt: '2026-09-02T03:40:00Z' },
      { body: 'newest', status: 'monitoring', displayAt: '2026-09-02T03:55:00Z' },
    ];
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents }));
    expect(r.description).toBe('newest');
  });

  it('an active service_disruption incident outranks all-available components', () => {
    const incidents = structuredClone(fixture('Docusign-incidents'));
    incidents.incidents[1].status = 'investigating';
    incidents.incidents[1].impact = 'service_disruption';
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents }));
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.incidentName).toMatch(/Incident 5674/);
  });

  it('an active incident with an unrecognised impact fails closed', () => {
    const incidents = structuredClone(fixture('Docusign-incidents'));
    incidents.incidents[0].status = 'investigating';
    incidents.incidents[0].impact = 'catastrophic';
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents }));
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/catastrophic/);
  });

  it('an active incident whose impact is "available" is context, not a vote', () => {
    const incidents = structuredClone(fixture('Docusign-incidents'));
    incidents.incidents[2].status = 'monitoring'; // impact: available in the capture
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents }));
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.incidentName).toMatch(/Incident 5648/);
  });

  it('resolved incidents are history, never the row', () => {
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: fixture('Docusign-incidents') }));
    expect(r.incidentName).toBe('');
    expect(r.description).toBe('');
  });

  it('an incident that carries no status is an unknown vote: it cannot be told from an active one', () => {
    for (const bad of [{ id: 'b', title: 'Old one', impact: 'available' }, { title: 'Old one', status: null }, null, 'text']) {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: { incidents: [bad] } }));
      expect(r.severity, JSON.stringify(bad)).toBe(SEVERITY.UNKNOWN);
      expect(r.warnings, JSON.stringify(bad)).toEqual(['1 incident in the list carries no status, so it cannot be told from an active one']);
    }
  });

  it("many incidents with no status are one warning with a count, and none of the vendor's words", () => {
    // The dashboard rewrites warnings that contain "timed out", "not found"
    // and the like into "could not be reached". An incident title can hold
    // those words, so the warning carries a count and no title.
    const many = Array.from({ length: 110 }, (_, n) => ({ id: `i${n}`, title: 'Envelope sends timed out; page not found' }));
    const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: { incidents: many } }));
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings).toEqual(['110 incidents in the list carry no status, so they cannot be told from active ones']);
  });

  it('an incident with no status does not outrank or hide an active one beside it', () => {
    const r = parseDocusign(fixture('Docusign-components'), opts({
      incidents: { incidents: [
        { id: 'a', title: 'Slow', status: 'investigating', impact: 'performance_degradation', events: [] },
        { id: 'b', title: 'Old one', status: null },
      ] },
    }));
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.incidentName).toBe('Slow');
    expect(r.warnings).toEqual(['1 incident in the list carries no status, so it cannot be told from an active one']);
  });

  // Docusign's incidents feed also carries PLANNED events (`isPlanned: true`,
  // type `maintenance` or `release`) with their own status words: scheduled,
  // in_progress, completed, canceled. Captured live 2026-11-25, when three
  // December releases marked `service_disruption` painted the row Major outage.
  describe('planned events (maintenance and releases)', () => {
    const planned = () => structuredClone(fixture('Docusign-incidents-planned'));
    const at = (iso) => () => new Date(iso);
    const one = (over) => ({ incidents: [{
      id: 'p', title: 'Release 9 (Rel 1)', status: 'scheduled', impact: 'service_disruption', type: 'release', isPlanned: true,
      beginsAt: '2026-12-08T03:00:00Z', endsAt: '2026-12-08T09:00:00Z',
      events: [{ body: 'Service will be unavailable.', status: 'scheduled', displayAt: '2026-11-25T14:00:00Z' }],
      ...over,
    }] });

    it('the live capture of 2026-11-25 reads operational: future releases and finished maintenance are not live', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: planned(), now: at('2026-11-25T14:50:00Z') }));
      expect(r.severity).toBe(SEVERITY.OPERATIONAL);
      expect(r.incidentName).toBe('');
      expect(r.description).toBe('');
      expect(r.warnings).toEqual([]);
    });

    it('a scheduled event that has not begun casts no vote and sets no headline', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({}), now: at('2026-12-08T02:59:59Z') }));
      expect(r.severity).toBe(SEVERITY.OPERATIONAL);
      expect(r.incidentName).toBe('');
    });

    it('a scheduled event whose window has passed casts no vote', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({}), now: at('2026-12-08T09:00:00Z') }));
      expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    });

    it('completed and canceled events cast no vote, whatever their impact', () => {
      for (const status of ['completed', 'canceled', 'Cancelled']) {
        const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({ status }), now: at('2026-12-08T04:00:00Z') }));
        expect(r.severity, status).toBe(SEVERITY.OPERATIONAL);
        expect(r.incidentName, status).toBe('');
      }
    });

    it('an in-progress event is maintenance, with its title and latest update on the card', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({ status: 'in_progress' }), now: at('2026-12-08T04:00:00Z') }));
      expect(r.severity).toBe(SEVERITY.MAINTENANCE);
      expect(r.incidentName).toBe('Release 9 (Rel 1)');
      expect(r.description).toBe('Service will be unavailable.');
    });

    it('an in-progress event is maintenance even outside its stated window (the vendor says it is running)', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({ status: 'in_progress' }), now: at('2026-12-08T10:00:00Z') }));
      expect(r.severity).toBe(SEVERITY.MAINTENANCE);
    });

    it('a still-"scheduled" event inside its window is maintenance (the vendor has not flipped the word yet)', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({}), now: at('2026-12-08T03:00:00Z') }));
      expect(r.severity).toBe(SEVERITY.MAINTENANCE);
      expect(r.incidentName).toBe('Release 9 (Rel 1)');
    });

    it('a scheduled event whose window cannot be read fails closed to unknown', () => {
      for (const over of [{ beginsAt: null }, { endsAt: 'soon' }, { beginsAt: undefined, endsAt: undefined }, { endsAt: '2026-12-08T03:00:00Z' }, { beginsAt: '2026-12-08T09:00:00Z' },
        { beginsAt: 'December 8 03:00 UTC', endsAt: 'December 8 09:00 UTC' }, { beginsAt: '2026-12-08T03:00:00', endsAt: '2026-12-08T09:00:00' },
        { beginsAt: '2026-02-31T03:00:00Z', endsAt: '2026-03-04T03:00:00Z' }, { beginsAt: '2026-12-08T24:00:00Z' }, { endsAt: '2026-12-08T09:00:00+25:00' }]) {
        const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one(over), now: at('2026-12-08T04:00:00Z') }));
        expect(r.severity, JSON.stringify(over)).toBe(SEVERITY.UNKNOWN);
        expect(r.warnings.join(' '), JSON.stringify(over)).toMatch(/window/);
      }
    });

    it('a planned status word never seen before fails closed to unknown, naming the word', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({ status: 'postponed' }), now: at('2026-11-25T14:50:00Z') }));
      expect(r.severity).toBe(SEVERITY.UNKNOWN);
      expect(r.warnings.join(' ')).toMatch(/postponed/);
    });

    it('an entry typed maintenance or release is planned even without isPlanned', () => {
      for (const type of ['maintenance', 'release']) {
        const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({ isPlanned: undefined, type }), now: at('2026-11-25T14:50:00Z') }));
        expect(r.severity, type).toBe(SEVERITY.OPERATIONAL);
      }
    });

    it('an entry that says isPlanned: false is an incident, whatever its type: its impact votes', () => {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: one({ isPlanned: false, status: 'investigating' }), now: at('2026-11-25T14:50:00Z') }));
      expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    });

    it('a real incident beside live maintenance still leads, and outranks it', () => {
      const incidents = one({ status: 'in_progress' });
      incidents.incidents.push({ id: 'i', title: 'Slow sends', status: 'investigating', impact: 'performance_degradation', type: 'incident', isPlanned: false, events: [] });
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents, now: at('2026-12-08T04:00:00Z') }));
      expect(r.severity).toBe(SEVERITY.DEGRADED);
      expect(r.incidentName).toBe('Slow sends');
    });

    it('components still vote during maintenance: a disrupted site outranks it', () => {
      const payload = structuredClone(fixture('Docusign-components'));
      byName(payload, 'NA1').status = 'service_disruption';
      const r = parseDocusign(payload, opts({ incidents: one({ status: 'in_progress' }), now: at('2026-12-08T04:00:00Z') }));
      expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    });
  });

  it('a missing or malformed incidents feed warns but lets the components decide', () => {
    for (const bad of [undefined, null, 'html', {}, { incidents: 'nope' }]) {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: bad }));
      expect(r.severity, String(bad)).toBe(SEVERITY.OPERATIONAL);
      expect(r.warnings.join(' '), String(bad)).toMatch(/incident/i);
    }
  });
});
