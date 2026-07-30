import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectComponents } from '../../src/engine/scope.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

const cloudflare = fixture('Cloudflare');
const github = fixture('GitHub');

// Audit finding H3: FILTERS was declared in config and accepted as a function
// parameter, but never read in the body -- so the tool had no way to express
// "I care about Workers, not the Guam edge PoP". Measured consequences on live
// data: Cloudflare under-reported (46 non-operational components, mostly edge
// PoPs, vs the vendor's own 'minor'), KnowBe4 over-reported (an incident about
// their online store while the vendor's own indicator said 'none').

describe('selectComponents — group scoping (the Cloudflare case)', () => {
  it('the fixture really is the hard case: hundreds of components across regions', () => {
    expect(cloudflare.components.length).toBeGreaterThan(400);
    const groups = cloudflare.components.filter((c) => c.group);
    expect(groups.map((g) => g.name)).toContain('Cloudflare Sites and Services');
    expect(groups.map((g) => g.name)).toContain('Oceania');
  });

  it('selects only members of the named group', () => {
    const { selected } = selectComponents(cloudflare, { groups: ['Cloudflare Sites and Services'] });
    expect(selected.length).toBeGreaterThan(50);

    // Assert the invariant STRUCTURALLY (no component from a geographic group
    // survives) rather than by matching an IATA-looking "(XXX)" name suffix.
    // The name heuristic was tried first and is wrong: "Data Loss Prevention
    // (DLP)", "Digital Experience Monitoring (DEX)" and "Cloud Network
    // Interconnect (CNI)" are real services whose names end in a three-letter
    // acronym, indistinguishable from an airport code. Group membership is the
    // actual boundary, so test that.
    const geoGroupIds = new Set(
      cloudflare.components
        .filter((c) => c.group && c.name !== 'Cloudflare Sites and Services')
        .map((g) => g.id),
    );
    expect(selected.some((c) => geoGroupIds.has(c.group_id))).toBe(false);
  });

  // D1: services only. This is the decision, expressed as a test.
  it('suppresses edge-PoP noise so routine re-routing does not read as an outage', () => {
    const unscoped = selectComponents(cloudflare, {});
    const scoped = selectComponents(cloudflare, { groups: ['Cloudflare Sites and Services'] });

    const bad = (r) => r.selected.filter((c) => c.status !== 'operational');
    expect(bad(unscoped).length).toBeGreaterThan(20); // the false-red state
    expect(bad(scoped).length).toBe(0); // signal only
  });

  it('never returns group headers themselves as selected components', () => {
    const { selected } = selectComponents(cloudflare, { groups: ['Cloudflare Sites and Services'] });
    expect(selected.every((c) => !c.group)).toBe(true);
  });
});

describe('selectComponents — component scoping', () => {
  it('selects components by exact name', () => {
    const { selected } = selectComponents(cloudflare, { components: ['Workers', 'Dashboard'] });
    expect(selected.map((c) => c.name).sort()).toEqual(['Dashboard', 'Workers']);
  });

  it('unions group and component selections without duplicating', () => {
    const { selected } = selectComponents(cloudflare, {
      groups: ['Cloudflare Sites and Services'],
      components: ['Workers'],
    });
    const workers = selected.filter((c) => c.name === 'Workers');
    expect(workers).toHaveLength(1);
  });
});

// Audit finding L4: "DNS" is configured for Cloudflare but is not a component
// name in the live payload. Dead config nobody noticed was dead, because H3
// meant the config was never consulted at all.
describe('selectComponents — config drift detection', () => {
  it('warns when a configured component name matches nothing live', () => {
    const { warnings } = selectComponents(cloudflare, { components: ['Workers', 'DNS'] });
    expect(warnings.join(' ')).toMatch(/DNS/);
    expect(warnings.join(' ')).not.toMatch(/Workers/);
  });

  it('warns when a configured group name matches nothing live', () => {
    const { warnings } = selectComponents(cloudflare, { groups: ['Atlantis'] });
    expect(warnings.join(' ')).toMatch(/Atlantis/);
  });

  it('reports no warnings when every configured name resolves', () => {
    const { warnings } = selectComponents(cloudflare, { components: ['Workers', 'Dashboard'] });
    expect(warnings).toEqual([]);
  });
});

describe('selectComponents — unscoped behaviour', () => {
  it('returns every non-group component when no scope is configured', () => {
    const { selected } = selectComponents(github, {});
    const expected = github.components.filter((c) => !c.group);
    expect(selected).toHaveLength(expected.length);
  });

  it('reports scoped=false when no scope was configured, so callers can fall back to the page indicator', () => {
    expect(selectComponents(github, {}).scoped).toBe(false);
    expect(selectComponents(github, { components: ['Git Operations'] }).scoped).toBe(true);
  });
});

describe('selectComponents — malformed input fails closed', () => {
  it('returns empty with a warning rather than throwing on a payload with no components', () => {
    const r = selectComponents({}, { components: ['Workers'] });
    expect(r.selected).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('tolerates a null payload', () => {
    expect(() => selectComponents(null, {})).not.toThrow();
    expect(selectComponents(null, {}).selected).toEqual([]);
  });
});
