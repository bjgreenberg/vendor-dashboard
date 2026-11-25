import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { addPageComponents, incidentIoComponents, isReadableIncidentIo } from '../../../src/engine/adapters/incidentio.js';
import { parseStatuspage } from '../../../src/engine/adapters/statuspage.js';
import { SEVERITY } from '../../../src/engine/severity.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`../../fixtures/${n}.json`, import.meta.url), 'utf8'));
const proxy = () => fixture('OpenAI-incidentio-20261125');
const summary = () => fixture('OpenAI-summary-20261125');
const now = () => new Date('2026-11-25T20:30:00Z');

/** A one-group incident.io document: group "G" holding the given leaves. */
const doc = (leaves, affected = []) => ({
  summary: {
    components: leaves.map(([id, name]) => ({ id, name })),
    affected_components: affected.map(([component_id, status]) => ({ component_id, status })),
    structure: {
      items: [{ group: { id: 'g1', name: 'G', components: leaves.map(([id, name]) => ({ component_id: id, name })) } }],
    },
  },
});

// OpenAI's page moved to incident.io. Its Statuspage-compatible summary.json lists 25 of the page's 37
// components and leaves the whole Codex group out, so on 2026-11-25 the board read Degraded (the indicator)
// above "24 components · all healthy" while OpenAI's own page showed Codex degraded. incident.io's page JSON
// (/proxy/<host>) holds every group and which component is affected.
describe('incident.io page JSON (OpenAI, 2026-11-25)', () => {
  it('reads every group and leaf of the live capture, with the affected one marked', () => {
    const { components, warnings } = incidentIoComponents(proxy());
    expect(warnings).toEqual([]);
    const groups = components.filter((c) => c.group).map((c) => c.name);
    expect(groups).toEqual(['APIs', 'ChatGPT', 'Codex', 'FedRAMP', 'Ads Platform']);
    const leaves = components.filter((c) => !c.group);
    expect(leaves).toHaveLength(37);
    expect(leaves.find((c) => c.name === 'Codex Web')).toMatchObject({ status: 'degraded_performance' });
    expect(components.find((c) => c.name === 'Codex')).toMatchObject({ group: true, status: 'degraded_performance' });
    expect(leaves.filter((c) => c.status !== 'operational').map((c) => c.name)).toEqual(['Codex Web']);
  });

  it('with the summary feed, the card names Codex Web and is still Degraded', () => {
    const { components } = incidentIoComponents(proxy());
    const payload = { ...summary(), components: [...summary().components, ...components] };
    const r = parseStatuspage(payload, { vendor: 'OpenAI', now });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.components.filter((c) => c.severity !== SEVERITY.OPERATIONAL).map((c) => c.name)).toEqual(['Codex Web']);
  });

  it('a status word it has never seen fails closed to unknown, never operational', () => {
    const { components } = incidentIoComponents(doc([['a', 'A']], [['a', 'sort_of_down']]));
    const r = parseStatuspage({ status: { indicator: 'none' }, components }, { vendor: 'V', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('an affected component the structure does not name is kept as unknown, with a warning', () => {
    const { components, warnings } = incidentIoComponents(doc([['a', 'A']], [['zzz', 'degraded_performance']]));
    const ghost = components.find((c) => !c.group && c.status !== 'operational');
    expect(ghost).toMatchObject({ status: 'degraded_performance' });
    expect(warnings.join(' ')).toMatch(/zzz/);
    const r = parseStatuspage({ status: { indicator: 'none' }, components }, { vendor: 'V', now });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });

  it('a group takes the worst of its leaves', () => {
    const { components } = incidentIoComponents(
      doc([['a', 'A'], ['b', 'B']], [['a', 'degraded_performance'], ['b', 'partial_outage']]),
    );
    expect(components.find((c) => c.group)).toMatchObject({ status: 'partial_outage' });
  });

  it('an affected entry it cannot attribute is an unknown vote with a warning, never dropped (Codex on #210)', () => {
    const d = doc([['a', 'A']]);
    d.summary.affected_components = [null, { status: 'partial_outage' }, { component_id: 7, status: 'x' }];
    const { components, warnings } = incidentIoComponents(d);
    expect(warnings).toEqual(['3 affected entries on the status page name no component, so they are counted as unknown']);
    const r = parseStatuspage({ status: { indicator: 'none' }, components }, { vendor: 'V', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('reads an ungrouped component, and names a nameless one by its id', () => {
    const d = { summary: { components: [{ id: 'u' }], affected_components: [{ component_id: 'u', status: 'partial_outage' }],
      structure: { items: [{ component: { component_id: 'u', name: '  ' } }] } } };
    const { components } = incidentIoComponents(d);
    expect(components).toEqual([{ id: 'u', name: 'u', status: 'partial_outage' }]);
  });

  // Codex on #210: the summary and the page JSON share component ids. Two entries with one id let a scoped read
  // keep the first (the summary's, possibly stale); one entry per id, with the worse status, never can.
  it('merges a component both documents list into one entry with the worse status', () => {
    const summaryList = [{ id: 'a', name: 'A', status: 'major_outage' }, { id: 'b', name: 'B', status: 'operational' }];
    const page = [{ id: 'g', name: 'G', group: true, status: 'degraded_performance' },
      { id: 'a', name: 'A', status: 'operational', group_id: 'g' }, { id: 'b', name: 'B', status: 'degraded_performance', group_id: 'g' },
      { id: 'c', name: 'C', status: 'operational', group_id: 'g' }];
    const merged = addPageComponents(summaryList, page);
    expect(merged.filter((c) => c.id === 'a')).toEqual([{ id: 'a', name: 'A', status: 'major_outage', group_id: 'g' }]);
    expect(merged.filter((c) => c.id === 'b')).toEqual([{ id: 'b', name: 'B', status: 'degraded_performance', group_id: 'g' }]);
    expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'g', 'c']);
    expect(addPageComponents(undefined, page)).toHaveLength(4);
  });

  it('a structure with no readable leaf is not a reading (Codex on #210)', () => {
    const empty = proxy();
    empty.summary.structure.items = [{ group: { id: 'g', name: 'G', components: [{}, null] } }, { other: 1 }];
    expect(isReadableIncidentIo(empty)).toBe(false);
  });

  it('is a reading only when it has components, a structure and an affected list (Codex on #210)', () => {
    expect(isReadableIncidentIo(proxy())).toBe(true);
    const noList = proxy();
    noList.summary.affected_components = { component_id: 'x' };
    expect(isReadableIncidentIo(noList)).toBe(false);
    delete noList.summary.affected_components;
    expect(isReadableIncidentIo(noList)).toBe(false);
    const none = proxy();
    none.summary.affected_components = [];
    expect(isReadableIncidentIo(none)).toBe(true);
    for (const bad of [null, {}, { summary: {} }, { summary: { components: [], structure: { items: [] } } }, 'x']) {
      expect(isReadableIncidentIo(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
