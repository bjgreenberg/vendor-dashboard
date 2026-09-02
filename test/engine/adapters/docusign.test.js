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

  it('a missing or malformed incidents feed warns but lets the components decide', () => {
    for (const bad of [undefined, null, 'html', {}, { incidents: 'nope' }]) {
      const r = parseDocusign(fixture('Docusign-components'), opts({ incidents: bad }));
      expect(r.severity, String(bad)).toBe(SEVERITY.OPERATIONAL);
      expect(r.warnings.join(' '), String(bad)).toMatch(/incident/i);
    }
  });
});
