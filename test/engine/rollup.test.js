import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { rollUp, visibleChildren } from '../../src/engine/rollup.js';
import { parseStatuspage } from '../../src/engine/adapters/statuspage.js';
import { SEVERITY } from '../../src/engine/severity.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

const child = (name, severity) => ({ name, severity });

// Requirement (Brian, 2026-07-30): a vendor is a parent of many sub-services.
// When everything under it is healthy, one green parent row is enough. When
// something is not healthy, break out the affected sub-services readably --
// but only the affected ones, never the full listing.

describe('rollUp — parent severity', () => {
  it('is operational when every child is operational', () => {
    const r = rollUp('Google', [child('Gmail', SEVERITY.OPERATIONAL), child('Drive', SEVERITY.OPERATIONAL)]);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('takes the worst child severity', () => {
    const r = rollUp('Google', [
      child('Gmail', SEVERITY.OPERATIONAL),
      child('Drive', SEVERITY.MAJOR_OUTAGE),
      child('Chat', SEVERITY.DEGRADED),
    ]);
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('is operational with no children at all', () => {
    expect(rollUp('Solo', []).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('honours an explicit parent severity that is worse than any child', () => {
    // e.g. a vendor page indicator reporting trouble the component list
    // has not caught up with yet. Never report healthier than either source.
    const r = rollUp('Vendor', [child('A', SEVERITY.OPERATIONAL)], { parentSeverity: SEVERITY.DEGRADED });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });
});

describe('visibleChildren — progressive disclosure', () => {
  it('shows NOTHING when the parent is all-green (collapsed row)', () => {
    const r = rollUp('Google', [child('Gmail', SEVERITY.OPERATIONAL), child('Drive', SEVERITY.OPERATIONAL)]);
    expect(visibleChildren(r)).toEqual([]);
    expect(r.collapsed).toBe(true);
  });

  it('breaks out ONLY the unhealthy children when something is wrong', () => {
    const r = rollUp('Google', [
      child('Gmail', SEVERITY.OPERATIONAL),
      child('Drive', SEVERITY.MAJOR_OUTAGE),
      child('Calendar', SEVERITY.OPERATIONAL),
      child('Chat', SEVERITY.DEGRADED),
    ]);
    expect(r.collapsed).toBe(false);
    expect(visibleChildren(r).map((c) => c.name)).toEqual(['Drive', 'Chat']);
  });

  it('orders broken-out children most severe first, then alphabetically', () => {
    const r = rollUp('V', [
      child('Zulu', SEVERITY.DEGRADED),
      child('Alpha', SEVERITY.DEGRADED),
      child('Mike', SEVERITY.MAJOR_OUTAGE),
    ]);
    expect(visibleChildren(r).map((c) => c.name)).toEqual(['Mike', 'Alpha', 'Zulu']);
  });

  it('surfaces an unknown child rather than hiding it', () => {
    // A child we could not evaluate must not be silently swallowed by an
    // otherwise-green parent (audit finding H4, applied to roll-up).
    const r = rollUp('V', [child('Good', SEVERITY.OPERATIONAL), child('Unreadable', SEVERITY.UNKNOWN)]);
    expect(r.collapsed).toBe(false);
    expect(visibleChildren(r).map((c) => c.name)).toEqual(['Unreadable']);
  });
});

describe('rollUp — real payloads', () => {
  it('Cloudflare scoped to services collapses to a single green row', () => {
    const rec = parseStatuspage(fixture('Cloudflare'), {
      vendor: 'Cloudflare',
      scope: { groups: ['Cloudflare Sites and Services'] },
    });
    const r = rollUp(rec.vendor, rec.components, { parentSeverity: rec.severity });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.collapsed).toBe(true);
    expect(visibleChildren(r)).toEqual([]);
  });

  it('a real Anthropic outage breaks out exactly the affected services', () => {
    const rec = parseStatuspage(fixture('Anthropic-outage'), { vendor: 'Anthropic' });
    const r = rollUp(rec.vendor, rec.components, { parentSeverity: rec.severity });
    expect(r.collapsed).toBe(false);
    const names = visibleChildren(r).map((c) => c.name);
    expect(names).toContain('Claude Code');
    expect(names).toContain('Claude API (api.anthropic.com)');
    // The healthy ones stay hidden.
    expect(names).not.toContain('Claude for Government');
    expect(names).not.toContain('Claude Console (platform.claude.com)');
  });

  it('does not dump a large healthy component list into the view', () => {
    const rec = parseStatuspage(fixture('Zoom'), { vendor: 'Zoom' });
    const r = rollUp(rec.vendor, rec.components, { parentSeverity: rec.severity });
    if (r.severity === SEVERITY.OPERATIONAL) {
      expect(visibleChildren(r)).toEqual([]);
      expect(rec.components.length).toBeGreaterThan(5); // there ARE many; we just hide them
    }
  });
});
