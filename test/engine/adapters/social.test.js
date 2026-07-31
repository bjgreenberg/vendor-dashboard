import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SEVERITY } from '../../../src/engine/severity.js';
import { parseMetaStatus, metaSeverity } from '../../../src/engine/adapters/metastatus.js';
import { parseSignal } from '../../../src/engine/adapters/signal.js';

const json = (n) => JSON.parse(readFileSync(new URL(`../../fixtures/${n}.json`, import.meta.url), 'utf8'));
const text = (n) => readFileSync(new URL(`../../fixtures/${n}`, import.meta.url), 'utf8');
const now = () => new Date('2026-07-31T12:00:00Z');

describe('meta', () => {
  it('reports operational from the real all-clear payload', () => {
    expect(parseMetaStatus(json('Meta-orgs'), { vendor: 'Meta', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('lists one component per product', () => {
    const r = parseMetaStatus(json('Meta-orgs'), { vendor: 'Meta', now });
    expect(r.components.length).toBeGreaterThan(10);
    expect(r.components.map((c) => c.name)).toContain('WhatsApp Business Platform');
  });

  // The same consumer/enterprise trap as the Microsoft endpoint, inverted:
  // labelling this plain "Meta" would imply consumer Instagram is covered.
  it('labels itself as business and developer platforms, and says so', () => {
    const r = parseMetaStatus(json('Meta-orgs'), { vendor: 'Meta', now });
    expect(r.service).toMatch(/business.*developer/i);
    expect(r.warnings.join(' ')).toMatch(/Consumer Facebook, Instagram and WhatsApp are not reported/i);
  });

  it('maps Meta\'s prose statuses onto the enum', () => {
    expect(metaSeverity('No known issues')).toBe(SEVERITY.OPERATIONAL);
    expect(metaSeverity('Major outage')).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(metaSeverity('Some issues')).toBe(SEVERITY.PARTIAL_OUTAGE);
  });

  it('fails closed on prose it does not recognise', () => {
    expect(metaSeverity('bananas')).toBe(SEVERITY.UNKNOWN);
    expect(metaSeverity('')).toBe(SEVERITY.UNKNOWN);
    expect(parseMetaStatus(null, { vendor: 'Meta', now }).severity).toBe(SEVERITY.UNKNOWN);
    expect(parseMetaStatus([], { vendor: 'Meta', now }).severity).toBe(SEVERITY.UNKNOWN);
  });

  it('surfaces an affected product', () => {
    const payload = [
      { id: 'a', name: 'Graph API', services: [{ name: 'API', status: 'Major outage' }] },
      { id: 'b', name: 'Marketing API', services: [{ name: 'API', status: 'No known issues' }] },
    ];
    const r = parseMetaStatus(payload, { vendor: 'Meta', now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components.find((c) => c.name === 'Graph API').severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });
});

describe('signal', () => {
  it('reports operational from the real page', () => {
    expect(parseSignal(text('Signal.html'), { vendor: 'Signal', now }).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('detects a down verdict', () => {
    expect(parseSignal('<html><body>Signal is down</body></html>', { vendor: 'Signal', now }).severity)
      .toBe(SEVERITY.MAJOR_OUTAGE);
  });

  // NOT the H6 mistake: H6 matched a bare word that appeared incidentally in
  // markup. This matches a specific sentence and fails closed otherwise.
  it('fails closed when the page carries no recognisable verdict', () => {
    const r = parseSignal('<html><body>Welcome to Signal, the private messenger.</body></html>', { vendor: 'Signal', now });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.warnings.join(' ')).toMatch(/structure may have changed/i);
  });

  it('fails closed on null', () => {
    expect(parseSignal(null, { vendor: 'Signal', now }).severity).toBe(SEVERITY.UNKNOWN);
  });
});
