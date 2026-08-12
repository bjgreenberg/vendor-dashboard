import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseZscaler } from '../../../src/engine/adapters/zscaler.js';
import { SEVERITY } from '../../../src/engine/severity.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'));

const opts = (over = {}) => ({ vendor: 'Zscaler', sourceUrl: 'https://trust.zscaler.com', ...over });

// Live captures, 2026-08-12. zsn carries a REAL active Service Degradation
// ("Intermittent Login Failures for claude.ai", severityTid 19); zpa and zdx
// were healthy. Cloud documents do not name their own cloud, so the collector
// pairs each with its configured label.
const zsn = () => ({ label: 'ZIA · zscaler.net', data: fixture('Zscaler-zsn') });
const zpa = () => ({ label: 'ZPA · private.zscaler.com', data: fixture('Zscaler-zpa') });
const zdx = () => ({ label: 'ZDX · zdxcloud.net', data: fixture('Zscaler-zdx') });

/** Clone a cloud doc and rewrite the severity tid of every active event. */
const withSeverityTid = (cloud, tid) => {
  const c = structuredClone(cloud);
  for (const cat of c.data.data.category) {
    for (const sub of cat.subCategory) {
      for (const ev of sub.category_status ?? []) ev.severityTid = tid;
    }
  }
  return c;
};

describe('parseZscaler — healthy clouds', () => {
  it('reports operational when every cloud is clear of active events', () => {
    const r = parseZscaler([zpa(), zdx()], opts());
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components).toHaveLength(2);
    expect(r.components.every((c) => c.severity === SEVERITY.OPERATIONAL)).toBe(true);
  });
});

describe('parseZscaler — active events decide severity via the payload legend', () => {
  it('detects the live Service Degradation on zscaler.net', () => {
    const r = parseZscaler([zsn(), zpa(), zdx()], opts());
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    const cloud = r.components.find((c) => c.name === 'ZIA · zscaler.net');
    expect(cloud.severity).toBe(SEVERITY.DEGRADED);
    expect(r.incidentName).toBe('Intermittent Login Failures for claude.ai');
    expect(r.description).toMatch(/Data Protection/);
  });

  it('THE TRAP: the boolean status field must never be believed', () => {
    // Verified live 2026-08-12: the affected subCategory still says
    // `status: true` while its active event is a Service Degradation.
    // Deriving health from that boolean is a false green. This test pins the
    // trap into the fixture so a refactor toward the boolean fails loudly.
    const affected = fixture('Zscaler-zsn').data.category[0].subCategory
      .find((s) => (s.category_status ?? []).length > 0);
    expect(affected.status).toBe(true);
    const r = parseZscaler([zsn()], opts());
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('maps Service Disruption above Degradation', () => {
    const r = parseZscaler([withSeverityTid(zsn(), '20')], opts());
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('Under Investigation informs, it never votes (visible: 0 on the legend)', () => {
    const r = parseZscaler([withSeverityTid(zsn(), '17'), zpa()], opts());
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.description).toMatch(/Under investigation/i);
  });

  it('Informational and Security Advisory noise is ignored entirely', () => {
    for (const tid of ['1356', '641', '1361']) {
      const r = parseZscaler([withSeverityTid(zsn(), tid)], opts());
      expect(r.severity).toBe(SEVERITY.OPERATIONAL);
      expect(r.description).not.toMatch(/claude\.ai/);
    }
  });
});

describe('parseZscaler — fails closed on anything it cannot verify', () => {
  it('an event with a severity tid missing from the legend votes UNKNOWN, not green', () => {
    const r = parseZscaler([withSeverityTid(zsn(), '9999'), zpa()], opts());
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/9999/);
  });

  it('an impacting severity with an unrecognised name votes UNKNOWN, not a guess', () => {
    const c = zsn();
    for (const s of c.data.data.severity) {
      if (s.tid === '19') s.name = 'Total Meltdown';
    }
    const r = parseZscaler([c], opts());
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/Total Meltdown/);
  });

  it('a failed cloud shows as unknown and warns, without sinking the others', () => {
    const r = parseZscaler([{ label: 'ZIA · zscalertwo.net', data: null }, zpa()], opts());
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    const failed = r.components.find((c) => c.name === 'ZIA · zscalertwo.net');
    expect(failed.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/zscalertwo/);
  });

  it('every cloud failing is UNKNOWN, never operational', () => {
    const r = parseZscaler(
      [{ label: 'a', data: null }, { label: 'b', data: null }],
      opts(),
    );
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('returns UNKNOWN for null, empty and garbage input, and never throws', () => {
    expect(parseZscaler(null, opts()).severity).toBe(SEVERITY.UNKNOWN);
    expect(parseZscaler([], opts()).severity).toBe(SEVERITY.UNKNOWN);
    expect(() => parseZscaler([{ label: 'x', data: { data: { category: 'nope' } } }], opts()))
      .not.toThrow();
    expect(parseZscaler([{ label: 'x', data: { data: { category: 'nope' } } }], opts()).severity)
      .toBe(SEVERITY.UNKNOWN);
  });
});

describe('parseZscaler — record shape', () => {
  it('emits the fields the dashboard sorts and renders on, with an injected clock', () => {
    const r = parseZscaler([zpa()], opts({ now: () => new Date('2026-01-01T00:00:00Z') }));
    expect(r).toMatchObject({
      vendor: 'Zscaler',
      severity: expect.any(String),
      description: expect.any(String),
      sourceUrl: expect.any(String),
      warnings: expect.any(Array),
    });
    expect(r.checkedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

// The config entry is load-bearing: URLs must pair 1:1 with labels, the first
// cloud must be the primary vendor.url (fetched with retries), and the per-PoP
// datacenter view must never be requested (services, not PoPs — decision D1's
// sibling for Zscaler).
describe('Zscaler config entry', () => {
  const cfg = JSON.parse(
    readFileSync(new URL('../../../config/vendors.json', import.meta.url), 'utf8'),
  );
  const entry = cfg.vendors.find((v) => v.name === 'Zscaler');

  it('exists, uses the zscaler adapter, and declares its clouds', () => {
    expect(entry, 'Zscaler entry missing from config/vendors.json').toBeDefined();
    expect(entry.type).toBe('zscaler');
    expect(Array.isArray(entry.clouds) && entry.clouds.length > 0).toBe(true);
  });

  it('every cloud has a unique label and a unique core_cloud_services URL', () => {
    const labels = entry.clouds.map((c) => c.label);
    const urls = entry.clouds.map((c) => c.url);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) {
      expect(u).toMatch(/^https:\/\/trust\.zscaler\.com\/api\/cloud-status\?cloud=/);
      expect(u).toContain('requestType=core_cloud_services');
      expect(u).not.toContain('requestType=datacenter');
    }
  });

  it('the primary url is the first cloud, so its document is not fetched twice', () => {
    expect(entry.url).toBe(entry.clouds[0].url);
  });

  it('is pinned to its own shard, apart from the other multi-fetch vendors', () => {
    const pinned = cfg.vendors.filter((v) => v.name !== 'Zscaler' && v.shard !== undefined);
    expect(typeof entry.shard).toBe('number');
    for (const v of pinned) expect(entry.shard).not.toBe(v.shard);
  });
});
