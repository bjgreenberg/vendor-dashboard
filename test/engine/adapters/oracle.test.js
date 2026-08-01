import { describe, it, expect } from 'vitest';
import { parseOracle, oracleSeverityOf } from '../../../src/engine/adapters/oracle.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Oracle publishes 8,730 region-service pairs across 90 regions. The row must
// show SERVICES; regions belong in the description. Reported 2026-08-01: the
// row had zero components because it was reading the 173-byte status.json,
// which carries only a page-level indicator.

const now = () => new Date('2026-08-01T02:00:00Z');
const parse = (p) => parseOracle(p, { vendor: 'Oracle Cloud', now });

const doc = (regions) => ({ realm: 'oc1', regionHealthReports: regions });
const region = (regionName, services) => ({
  regionId: regionName.toLowerCase(),
  regionName,
  serviceHealthReports: services.map(([serviceName, serviceStatus]) => ({ serviceName, serviceStatus })),
});

describe('oracle cloud', () => {
  it('lists services, not region-service pairs', () => {
    const r = parse(
      doc([
        region('Ashburn', [['Compute', 'NormalPerformance'], ['Object Storage', 'NormalPerformance']]),
        region('Frankfurt', [['Compute', 'NormalPerformance'], ['Object Storage', 'NormalPerformance']]),
      ]),
    );
    expect(r.components.map((c) => c.name).sort()).toEqual(['Compute', 'Object Storage']);
  });

  it('never puts a region in a component name', () => {
    const r = parse(doc([region('Ashburn', [['Compute', 'NormalPerformance']])]));
    expect(r.components[0].name).toBe('Compute');
    expect(r.components[0].name).not.toMatch(/Ashburn/);
  });

  it('carries the WORST status across regions and names the affected ones', () => {
    const r = parse(
      doc([
        region('Ashburn', [['Compute', 'NormalPerformance']]),
        region('Frankfurt', [['Compute', 'ServiceDisruption']]),
        region('Tokyo', [['Compute', 'DegradedPerformance']]),
      ]),
    );
    expect(r.components).toHaveLength(1);
    expect(r.components[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components[0].description).toMatch(/Frankfurt/);
    expect(r.components[0].description).toMatch(/Tokyo/);
    expect(r.components[0].description).not.toMatch(/Ashburn/); // healthy, not "affected"
  });

  it('sorts the worst services first', () => {
    const r = parse(
      doc([
        region('Ashburn', [
          ['Healthy Service', 'NormalPerformance'],
          ['Broken Service', 'ServiceDisruption'],
        ]),
      ]),
    );
    expect(r.components[0].name).toBe('Broken Service');
  });

  it('maps Oracle vocabulary, ignoring spacing and case', () => {
    expect(oracleSeverityOf('NormalPerformance')).toBe(SEVERITY.OPERATIONAL);
    expect(oracleSeverityOf('normal performance')).toBe(SEVERITY.OPERATIONAL);
    expect(oracleSeverityOf('DegradedPerformance')).toBe(SEVERITY.DEGRADED);
    expect(oracleSeverityOf('ServiceDisruption')).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(oracleSeverityOf('PartialServiceDisruption')).toBe(SEVERITY.PARTIAL_OUTAGE);
  });

  it('fails closed on an unrecognised status word', () => {
    expect(oracleSeverityOf('Sparkly')).toBe(SEVERITY.UNKNOWN);
    expect(oracleSeverityOf('')).toBe(SEVERITY.UNKNOWN);
    expect(oracleSeverityOf(null)).toBe(SEVERITY.UNKNOWN);
    const r = parse(doc([region('Ashburn', [['Compute', 'Sparkly']])]));
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('fails closed on a malformed payload', () => {
    for (const bad of [null, undefined, {}, { regionHealthReports: [] }, 'nope']) {
      expect(parse(bad).severity).toBe(SEVERITY.UNKNOWN);
    }
  });

  it('reports unknown rather than healthy when regions carry no services', () => {
    // An empty service list is not evidence of health.
    expect(parse(doc([region('Ashburn', [])])).severity).toBe(SEVERITY.UNKNOWN);
  });
});
