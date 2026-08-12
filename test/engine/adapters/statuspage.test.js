import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStatuspage } from '../../../src/engine/adapters/statuspage.js';
import { SEVERITY } from '../../../src/engine/severity.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'));

const opts = (over = {}) => ({ vendor: 'Test', sourceUrl: 'https://example.test', ...over });

describe('parseStatuspage — healthy vendors', () => {
  it('reports operational when the vendor is entirely clear', () => {
    const r = parseStatuspage(fixture('GitHub'), opts({ vendor: 'GitHub' }));
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.vendor).toBe('GitHub');
  });
});

// Audit finding M2. The predecessor derived status ONLY from incidents, further
// filtered to impact !== "none". A vendor that flips components to major_outage
// without opening an incident therefore reported "Systems operational."
describe('parseStatuspage — component-driven outages (M2)', () => {
  it('detects a real outage from the live payload', () => {
    const r = parseStatuspage(fixture('Anthropic-outage'), opts({ vendor: 'Anthropic' }));
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('REGRESSION: still detects the outage when NO incident is open', () => {
    // Same real payload, incidents[] emptied. Under the old incident-only logic
    // this returned "Operational" while 4 of 6 components were major_outage.
    const r = parseStatuspage(fixture('Anthropic-outage-no-incident'), opts({ vendor: 'Anthropic' }));
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('reads the page-level indicator, which the predecessor never consulted', () => {
    const payload = fixture('Anthropic-outage-no-incident');
    expect(payload.status.indicator).toBe('major');
    const r = parseStatuspage(payload, opts());
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });
});

// Audit finding H3, and decision D1 (Cloudflare = services only).
describe('parseStatuspage — scoping (H3)', () => {
  const cloudflare = fixture('Cloudflare');

  it('reports operational when every in-scope service is healthy, ignoring edge-PoP noise', () => {
    const r = parseStatuspage(
      cloudflare,
      opts({ vendor: 'Cloudflare', scope: { groups: ['Cloudflare Sites and Services'] } }),
    );
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('a configured scope overrides the page indicator — the user declared what matters', () => {
    // Cloudflare's own indicator is "minor" because of re-routed PoPs. With
    // services-only scope configured, that must NOT drag the row amber.
    expect(cloudflare.status.indicator).toBe('minor');
    const r = parseStatuspage(
      cloudflare,
      opts({ scope: { groups: ['Cloudflare Sites and Services'] } }),
    );
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('without scope, falls back to the vendor indicator and reports the noise', () => {
    const r = parseStatuspage(cloudflare, opts({ vendor: 'Cloudflare' }));
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('surfaces config-drift warnings from scoping (L4)', () => {
    const r = parseStatuspage(cloudflare, opts({ scope: { components: ['Workers', 'DNS'] } }));
    expect(r.warnings.join(' ')).toMatch(/DNS/);
  });
});

// The mirror-image error: KnowBe4's own indicator says none, but an incident
// about their online store made the predecessor render the row Degraded.
describe('parseStatuspage — incidents inform context, never severity', () => {
  const knowbe4 = fixture('KnowBe4');

  it('does not mark a vendor down for an incident its own indicator calls none', () => {
    expect(knowbe4.status.indicator).toBe('none');
    expect(knowbe4.incidents[0].impact).toBe('major');
    const r = parseStatuspage(knowbe4, opts({ vendor: 'KnowBe4' }));
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('still surfaces the incident name so the context is not lost', () => {
    const r = parseStatuspage(knowbe4, opts({ vendor: 'KnowBe4' }));
    expect(r.incidentName).toMatch(/purchasing page/i);
  });
});

// Audit finding H4: fail closed. A parse failure must never render as green.
describe('parseStatuspage — malformed input fails closed (H4)', () => {
  it('returns UNKNOWN, not OPERATIONAL, for a null payload', () => {
    const r = parseStatuspage(null, opts());
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
  });

  it('returns UNKNOWN for a payload missing both status and components', () => {
    expect(parseStatuspage({}, opts()).severity).toBe(SEVERITY.UNKNOWN);
  });

  it('never throws on garbage', () => {
    expect(() => parseStatuspage({ status: 'not-an-object', components: 'nope' }, opts())).not.toThrow();
  });
});

describe('parseStatuspage — record shape', () => {
  it('emits the fields the dashboard sorts and renders on', () => {
    const r = parseStatuspage(fixture('GitHub'), opts({ vendor: 'GitHub' }));
    expect(r).toMatchObject({
      vendor: 'GitHub',
      severity: expect.any(String),
      description: expect.any(String),
      sourceUrl: expect.any(String),
      warnings: expect.any(Array),
    });
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts an injected clock so the record is deterministic under test', () => {
    const r = parseStatuspage(fixture('GitHub'), opts({ now: () => new Date('2026-01-01T00:00:00Z') }));
    expect(r.checkedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

// SHARED STATUS PAGES (2026-08-12). SendGrid decommissioned
// status.sendgrid.com — the stale CNAME serves a *.statuspage.io certificate
// and the Statuspage origin 302s to statuspage.io — and its status now lives
// as a slice of Twilio's 191-component page. Scope is what carves the slice
// out; these tests pin the three properties that make a shared page honest:
// the scope sees SendGrid trouble, Twilio trouble cannot leak in, and
// page-wide incident context is filtered to the scoped components.
describe('parseStatuspage — shared status page (SendGrid on Twilio)', () => {
  const vendorsConfig = JSON.parse(
    readFileSync(new URL('../../../config/vendors.json', import.meta.url), 'utf8'),
  );
  const entry = vendorsConfig.vendors.find((v) => v.name === 'SendGrid');
  const twilio = fixture('Twilio-sendgrid');
  const sgOpts = () =>
    opts({ vendor: 'SendGrid', scope: entry.scope, service: 'SendGrid' });

  it('config points SendGrid at Twilio\'s page — status.sendgrid.com is decommissioned', () => {
    expect(entry.url).toBe('https://status.twilio.com/api/v2/summary.json');
    expect(entry.scope, 'a shared page without a scope would report Twilio, not SendGrid').toBeTruthy();
  });

  it('the configured scope matches the recorded payload exactly — zero drift warnings', () => {
    const r = parseStatuspage(twilio, sgOpts());
    expect(r.warnings).toEqual([]);
    expect(r.severity).not.toBe(SEVERITY.UNKNOWN);
  });

  it('detects SendGrid trouble through the scope on the 191-component shared page', () => {
    // Live capture: "SendGrid API" was degraded_performance when recorded.
    const r = parseStatuspage(twilio, sgOpts());
    expect(r.severity).toBe(SEVERITY.DEGRADED);
  });

  it('Twilio-only trouble and the page indicator do not leak into the SendGrid row', () => {
    // Variant fixture: SendGrid healthy; Twilio's SMS/MMS/Voice degradations
    // and the page-wide "minor" indicator are untouched. The row must be green.
    const healthy = fixture('Twilio-sendgrid-healthy');
    expect(healthy.status.indicator).toBe('minor');
    const r = parseStatuspage(healthy, sgOpts());
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('scope selects the SendGrid group children and none of Twilio\'s', () => {
    const r = parseStatuspage(twilio, sgOpts());
    const names = r.components.map((c) => c.name);
    expect(names).toContain('SMTP'); // child of the "SendGrid Mail Sending" group
    expect(names).toContain('SendGrid API');
    expect(names).not.toContain('Mailsend: Comms API'); // child of TWILIO EMAIL
  });

  it('page-wide incident context is filtered to the scoped components', () => {
    // The capture holds two open incidents: an SMS-to-Pakistan one naming
    // "SMS, APAC" and an IP-retrieval one naming "SendGrid API". Only the
    // SendGrid one may surface on the SendGrid card.
    const r = parseStatuspage(twilio, sgOpts());
    expect(r.incidentName).toBe('IP Retrieval Failing for EU Regional Customers');
    expect(r.description).not.toMatch(/Zong Pakistan/);
  });

  it('an incident naming NO components is kept — context informs, it never votes', () => {
    const anonymous = structuredClone(twilio);
    for (const i of anonymous.incidents) i.components = [];
    const r = parseStatuspage(anonymous, sgOpts());
    // First open incident by page order; unattributable context stays visible.
    expect(r.incidentName).toBe('SMS Delivery Failures from Twilio to Zong Pakistan');
  });

  it('incident filtering does not apply to unscoped vendors', () => {
    const r = parseStatuspage(twilio, opts({ vendor: 'Twilio' }));
    expect(r.incidentName).toBe('SMS Delivery Failures from Twilio to Zong Pakistan');
  });
});
