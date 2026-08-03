import { describe, it, expect } from 'vitest';
import { parseGoogle } from '../../../src/engine/adapters/google.js';
import { parseBetterStack, parseBetterStackSections } from '../../../src/engine/adapters/betterstack.js';
import { parseConcur } from '../../../src/engine/adapters/concur.js';
import { coerceApplePayload } from '../../../src/engine/adapters/apple.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Audit finding M4, second pass: when the coverage gate went per-file, three
// adapters fell below the floor. The uncovered branches were not decoration —
// each one decides a severity or a component name. These tests pin them.

const now = () => new Date('2026-08-01T12:00:00Z');

describe('google — incident severity mapping', () => {
  const incident = (impact) => ({
    service_name: 'Gmail',
    status_impact: impact,
    external_desc: 'Something happened',
  });

  it('SERVICE_DISRUPTION maps to partial_outage', () => {
    const r = parseGoogle([incident('SERVICE_DISRUPTION')], { vendor: 'Google', now });
    expect(r.severity).toBe(SEVERITY.PARTIAL_OUTAGE);
  });

  it('SERVICE_OUTAGE maps to major_outage', () => {
    const r = parseGoogle([incident('SERVICE_OUTAGE')], { vendor: 'Google', now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('an unrecognised open impact degrades rather than alarms or greens', () => {
    // Not fully fail-closed to unknown, deliberately: the incident IS open —
    // Google said so — only its impact wording is new. Degraded states "there
    // is something here" without inventing an outage severity.
    const r = parseGoogle([incident('SOMETHING_NEW')], { vendor: 'Google', now });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });
});

describe('betterstack — unrecognised overview state fails closed', () => {
  it('a new state modifier yields unknown, never a guess', () => {
    const html = `<div class="status-page__overview-icon status-page__overview-icon--sparkles">`;
    const r = parseBetterStack(html, { vendor: 'Stormboard', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings[0]).toMatch(/unrecognised Better Stack state "sparkles"/);
  });
});

describe('betterstack — section resource names', () => {
  const section = (label) =>
    `<div class='status-page__resource-name'><img src="/status_pages/operational_small-abc.png">${label}</div>`;

  it('a URL resource is shown by its host — what a reader recognises', () => {
    const out = parseBetterStackSections(section('https://app.stormboard.com/health'));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('app.stormboard.com');
    expect(out[0].severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('a URL-shaped label the URL parser rejects keeps its raw text', () => {
    const out = parseBetterStackSections(section('https://%%%'));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('https://%%%');
  });
});

// Vitest 4's AST-aware coverage remapping exposed these as never-executed
// (the v3 ruler credited them): Apple's raw-text coercion path and
// BetterStack's page+sections merge. Both are real inputs in production —
// Apple serves a JS-wrapped payload, Stormboard's resources ride a separate
// fragment — so they get pinned, not threshold-waived.
describe('apple — payload coercion accepts objects and JS-wrapped text', () => {
  it('passes a parsed object straight through', () => {
    const obj = { services: [] };
    expect(coerceApplePayload(obj)).toBe(obj);
  });

  it('extracts the JSON object from a JS-wrapped body', () => {
    const wrapped = 'jsonCallback({"services":[{"serviceName":"iCloud"}]});';
    expect(coerceApplePayload(wrapped)).toEqual({ services: [{ serviceName: 'iCloud' }] });
  });

  it.each([
    ['non-string, non-object input', 42],
    ['text with no JSON object', 'entirely braceless'],
    ['braces in the wrong order', '}{'],
    ['invalid JSON between the braces', '{not json}'],
  ])('fails closed (null) on %s', (_label, input) => {
    expect(coerceApplePayload(input)).toBeNull();
  });
});

describe('betterstack — page state merges with the sections fragment', () => {
  const page = `<div class="status-page__overview-icon status-page__overview-icon--operational">`;
  const section = (icon, label) =>
    `<div class='status-page__resource-name'><img src="/status_pages/${icon}_small-abc.png">${label}</div>`;

  it('a broken resource outranks a green page-level state', () => {
    const r = parseBetterStack(page, {
      vendor: 'Stormboard',
      now,
      sections: section('downtime', 'https://api.stormboard.com/'),
    });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.incidentName).toBe('Active issue');
    expect(r.description).toBe('Affected: api.stormboard.com.');
  });

  it('healthy resources leave the page verdict green and name the count', () => {
    const r = parseBetterStack(page, {
      vendor: 'Stormboard',
      now,
      sections: section('operational', 'https://app.stormboard.com/'),
    });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.description).toBe('All 1 monitored services operational.');
  });
});

describe('concur — incident severity, catalogue, and banner interplay', () => {
  const openIncident = (severity) => ({
    severity,
    status: 'Open',
    end_epoch: 0,
    data_centers: ['US2'],
  });

  it('"Service Disruption" maps to partial_outage', () => {
    const r = parseConcur({ incidents: [openIncident('Service Disruption')] }, { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.PARTIAL_OUTAGE);
  });

  it('"Performance Degradation" maps to degraded', () => {
    const r = parseConcur({ incidents: [openIncident('Performance Degradation')] }, { vendor: 'Concur', now });
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });

  it('the catalogue lists every service once, deduped across priority tiers', () => {
    const serviceCatalogue = {
      P1: { services: [{ name: 'Expense' }, { name: 'Travel' }] },
      P2: { services: [{ name: 'Expense' }, { name: '  ' }] },
    };
    const r = parseConcur({ incidents: [] }, { vendor: 'Concur', serviceCatalogue, now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.description).toBe('All 2 services operational.');
    expect(r.components.map((c) => c.name)).toEqual(['Expense', 'Travel']);
  });

  it('a displayed banner with no matching incident warns instead of staying silent', () => {
    const r = parseConcur(
      { incidents: [] },
      { vendor: 'Concur', banner: { data: { display: true } }, now },
    );
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
    expect(r.warnings[0]).toMatch(/banner is displayed but no matching open incident/);
  });
});
