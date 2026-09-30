import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { probeUrlsFor, secondOpinion } from '../../scripts/truth-check/rules.mjs';
import { decodeBody } from '../../scripts/truth-check/vendor-rules.mjs';

// The second-opinion readers for the 13 vendors the first truth-check batch
// could not read (worklist #124, 2026-09-30). Each is exercised against a
// recorded vendor payload in both directions — the vendor's healthy state
// reads `fine`, the vendor's trouble reads `trouble` — plus the failure mode
// that must never read `fine` (a missing or unrecognised verdict).
const raw = (name) => readFileSync(`test/fixtures/${name}`, 'utf8');
const fixture = (name) => JSON.parse(raw(name));
const html = (name) => ({ error: 'not JSON', text: raw(name) });
const config = JSON.parse(raw('../../config/vendors.json'));
const vendorNamed = (name) => config.vendors.find((v) => v.name === name);
const judge = (vendor, bodyByIndex, now) => {
  const urls = probeUrlsFor(vendor);
  const bodies = Object.fromEntries(urls.map((u, i) => [u, typeof bodyByIndex === 'function' ? bodyByIndex(i, u) : bodyByIndex]));
  return secondOpinion(vendor, bodies, now);
};

describe('coverage — every vendor on the board has a second opinion', () => {
  it('no configured vendor is left uncovered (the board says "49 of 49")', () => {
    const uncovered = config.vendors.filter((v) => probeUrlsFor(v).length === 0).map((v) => v.name);
    expect(uncovered).toEqual([]);
  });
});

describe('decodeBody — the fetch layer', () => {
  it('decodes AWS’s UTF-16 big-endian body by its byte-order mark', () => {
    const be = Buffer.from('﻿[{"status":"0"}]', 'utf16le').swap16();
    expect(JSON.parse(decodeBody(be))).toEqual([{ status: '0' }]);
  });
  it('decodes UTF-16 little-endian and strips a UTF-8 BOM', () => {
    expect(decodeBody(Buffer.from('﻿ok', 'utf16le'))).toBe('ok');
    expect(decodeBody(Buffer.from('﻿{"a":1}', 'utf8'))).toBe('{"a":1}');
  });
});

describe('Apple — event times, not the status word', () => {
  const apple = vendorNamed('Apple');
  const base = fixture('Apple.json');
  const withEvent = (e) => ({ ...base, services: [...base.services, { serviceName: 'App Store', events: [e] }] });
  const NOW = 1_790_800_000_000;
  it('resolved events only: fine', () => {
    expect(judge(apple, base, NOW).verdict).toBe('fine');
  });
  it('an event that has started and not ended: trouble, even if its status word is "resolved"', () => {
    const o = judge(apple, withEvent({ eventStatus: 'resolved', statusType: 'Outage', epochStartDate: NOW - 60_000, epochEndDate: null }), NOW);
    expect(o.verdict).toBe('trouble');
    expect(o.evidence[0]).toMatch(/App Store \(Outage\)/);
  });
  it('a scheduled event that has not started yet is not live', () => {
    expect(judge(apple, withEvent({ eventStatus: 'upcoming', epochStartDate: NOW + 3_600_000, epochEndDate: null }), NOW).verdict).toBe('fine');
  });
  it('reads the JavaScript-wrapped form too, and fails closed on a missing services array', () => {
    expect(judge(apple, { error: 'not JSON', text: `jsonCallback(${JSON.stringify(base)});` }, NOW).verdict).toBe('fine');
    expect(judge(apple, { error: 'not JSON', text: 'nope' }, NOW).verdict).toBe('unreadable');
  });
});

describe('AWS — numeric status, US scope honoured', () => {
  const aws = vendorNamed('AWS');
  const events = fixture('AWS-currentevents.json');
  it('open events only outside the US scope, plus a resolved one: fine, and says what it set aside', () => {
    const o = judge(aws, events);
    expect(o.verdict).toBe('fine');
    expect(o.evidence[0]).toMatch(/2 open outside scope/);
  });
  it('an open event in a US region: trouble', () => {
    const us = events.map((e) => (e.status === '3' ? { ...e, service: 'ec2-us-east-1' } : e));
    expect(judge(aws, us).verdict).toBe('trouble');
  });
  it('a global event (no region code) votes — fail closed', () => {
    expect(judge(aws, [{ service: 'iam', status: '1', summary: 'x' }]).verdict).toBe('trouble');
  });
  it('a body that is not an event array is unreadable', () => {
    expect(judge(aws, { error: 'HTTP 503' }).verdict).toBe('unreadable');
  });
});

describe('Concur — every data centre’s Current Status', () => {
  const concur = vendorNamed('Concur');
  const doc = fixture('Concur-status-history-us2.json');
  it('all normal across the data centres: fine', () => {
    expect(judge(concur, doc).verdict).toBe('fine');
  });
  it('one service not normal in one data centre: trouble', () => {
    const bad = structuredClone(doc);
    bad.data.Expense['Current Status'].status = 'degraded';
    expect(judge(concur, (i) => (i === 2 ? bad : doc)).verdict).toBe('trouble');
  });
  it('no data centre readable: unreadable; one missing is noted, not fatal', () => {
    expect(judge(concur, { error: 'HTTP 500' }).verdict).toBe('unreadable');
    const o = judge(concur, (i) => (i === 0 ? { error: 'HTTP 500' } : doc));
    expect(o.verdict).toBe('fine');
    expect(o.evidence[0]).toMatch(/1 data centre\(s\) unreadable/);
  });
});

describe('Discord — Statuspage through the voice-region lens', () => {
  const discord = vendorNamed('Discord');
  it('an API outage: trouble', () => {
    expect(judge(discord, fixture('Discord-api-outage.json')).verdict).toBe('trouble');
  });
  it('a non-US voice region down alone: fine (it informs, it does not vote)', () => {
    const p = structuredClone(fixture('Discord-api-outage.json'));
    for (const c of p.components) c.status = 'operational';
    const voice = p.components.find((c) => c.group && c.name === 'Voice');
    const tokyo = p.components.find((c) => c.group_id === voice.id && !discord.scope.regionGroups.Voice.includes(c.name));
    tokyo.status = 'major_outage';
    p.status.indicator = 'major';
    expect(judge(discord, p).verdict).toBe('fine');
  });
});

describe('Docusign — components and open incidents', () => {
  const ds = vendorNamed('Docusign');
  const comps = fixture('Docusign-components.json');
  const incidents = fixture('Docusign-incidents.json');
  it('all available, all incidents resolved: fine', () => {
    expect(judge(ds, (i) => (i === 0 ? comps : incidents)).verdict).toBe('fine');
  });
  it('a component in performance_degradation: trouble', () => {
    const bad = structuredClone(comps);
    bad.components[0].status = 'performance_degradation';
    expect(judge(ds, (i) => (i === 0 ? bad : incidents)).verdict).toBe('trouble');
  });
  it('an unresolved incident with impact: trouble', () => {
    const open = { incidents: [{ title: 'x', status: 'investigating', impact: 'service_disruption' }] };
    expect(judge(ds, (i) => (i === 0 ? comps : open)).verdict).toBe('trouble');
  });
});

describe('IBM Cloud — parsed statusItems', () => {
  const ibm = vendorNamed('IBM Cloud');
  const doc = fixture('IBM-enhancedstatus.json');
  it('resolved incidents only: fine', () => {
    expect(judge(ibm, doc).verdict).toBe('fine');
  });
  it('an incident in an open state: trouble', () => {
    const bad = structuredClone(doc);
    bad.statusItems.find((x) => x.type === 'incident').state = 'in-progress';
    expect(judge(ibm, bad).verdict).toBe('trouble');
  });
  it('no statusItems: unreadable', () => {
    expect(judge(ibm, { regions: [] }).verdict).toBe('unreadable');
  });
});

describe('Meta — exact status words', () => {
  const meta = vendorNamed('Meta');
  const orgs = fixture('Meta-orgs.json');
  it('"No known issues" everywhere: fine (the word "issues" alone is not trouble)', () => {
    expect(judge(meta, orgs).verdict).toBe('fine');
  });
  it('any other status: trouble', () => {
    const bad = structuredClone(orgs);
    (Array.isArray(bad) ? bad : bad.orgs)[0].services[0].status = 'Partial Outage';
    expect(judge(meta, bad).verdict).toBe('trouble');
  });
});

describe('Microsoft — every source of the composite', () => {
  const ms = vendorNamed('Microsoft');
  const types = ms.sources.map((s) => s.type);
  const healthy = {
    'microsoft-consumer': fixture('Microsoft-consumer.json'),
    'azure-post': { ...fixture('Azure-post.json'), Status: 'Available' },
    'azure-devops': fixture('AzureDevOps-health.json'),
    'microsoft-admin': [{ Status: 'Available', LastUpdatedTime: '2026-09-30T22:41:00Z' }],
  };
  const by = (over = {}) => (i) => over[i] ?? healthy[types[i]];
  it('all five sources healthy: fine', () => {
    expect(judge(ms, by()).verdict).toBe('fine');
  });
  it('Azure posting "Service degradation" (live 2026-09-30): trouble', () => {
    const azureAt = types.indexOf('azure-post');
    const o = judge(ms, by({ [azureAt]: { Status: 'Service degradation', Message: '<p>ExpressRoute Gateway</p>' } }));
    expect(o.verdict).toBe('trouble');
    expect(o.evidence.join(' ')).toMatch(/Azure: Service degradation — ExpressRoute Gateway/);
  });
  it('an Azure DevOps geography not healthy: trouble', () => {
    const ado = structuredClone(healthy['azure-devops']);
    ado.services[0].geographies[0].health = 'degraded';
    expect(judge(ms, by({ [types.indexOf('azure-devops')]: ado })).verdict).toBe('trouble');
  });
  it('a status word never seen: unreadable, never fine', () => {
    expect(judge(ms, by({ [types.indexOf('microsoft-admin')]: [{ Status: 'Sparkly' }] })).verdict).toBe('unreadable');
  });
});

describe('Okta — every embedded incident’s Status__c', () => {
  const okta = vendorNamed('Okta');
  it('all resolved: fine', () => {
    expect(judge(okta, html('Okta-statuspage.html')).verdict).toBe('fine');
  });
  it('one not resolved: trouble', () => {
    const page = raw('Okta-statuspage.html').replace('"Status__c":"Resolved"', '"Status__c":"Investigating"');
    expect(judge(okta, { error: 'not JSON', text: page }).verdict).toBe('trouble');
  });
  it('a page without incident records: unreadable', () => {
    expect(judge(okta, { error: 'not JSON', text: '<html></html>' }).verdict).toBe('unreadable');
  });
});

describe('Signal — the status symbol', () => {
  const signal = vendorNamed('Signal');
  it('a check mark: fine', () => {
    expect(judge(signal, html('Signal.html')).verdict).toBe('fine');
  });
  it('any other symbol: trouble', () => {
    const page = raw('Signal.html').replace('&check;', '&cross;');
    expect(judge(signal, { error: 'not JSON', text: page }).verdict).toBe('trouble');
  });
  it('no symbol: unreadable', () => {
    expect(judge(signal, { error: 'not JSON', text: '<html>Signal is up</html>' }).verdict).toBe('unreadable');
  });
});

describe('Better Stack (Stormboard) — the page heading, not the icon', () => {
  const sb = vendorNamed('Stormboard');
  it('"All services are online": fine', () => {
    expect(judge(sb, html('Stormboard-betterstack.html')).verdict).toBe('fine');
  });
  it('a heading about trouble: trouble; an unrecognised heading: unreadable', () => {
    const page = raw('Stormboard-betterstack.html');
    expect(judge(sb, { error: 'not JSON', text: page.replace('All services are online', 'Some services are down') }).verdict).toBe('trouble');
    expect(judge(sb, { error: 'not JSON', text: page.replace('All services are online', 'Hello') }).verdict).toBe('unreadable');
  });
});

describe('Salesforce (Tableau) — active production instances', () => {
  const tableau = vendorNamed('Tableau');
  const doc = fixture('Salesforce-Tableau.json');
  it('all OK: fine; an inactive instance does not count', () => {
    expect(judge(tableau, doc).verdict).toBe('fine');
  });
  it('an active production instance not OK: trouble', () => {
    const bad = structuredClone(doc);
    bad.Instances.find((i) => i.isActive && i.environment === 'production').status = 'MAJOR_INCIDENT_CORE';
    expect(judge(tableau, bad).verdict).toBe('trouble');
  });
});

describe('Zscaler — every cloud, by the legend’s visible flag', () => {
  const zs = vendorNamed('Zscaler');
  const quiet = fixture('Zscaler-zpa.json');
  const impacting = fixture('Zscaler-zsn.json');
  it('every cloud quiet: fine', () => {
    expect(judge(zs, quiet).verdict).toBe('fine');
  });
  it('one cloud with a service-impacting event: trouble, naming the cloud', () => {
    const o = judge(zs, (i) => (i === 3 ? impacting : quiet));
    expect(o.verdict).toBe('trouble');
    expect(o.evidence.join(' ')).toMatch(new RegExp(zs.clouds[3].label));
  });
  it('one cloud unreadable and none impacting: unreadable, never fine', () => {
    expect(judge(zs, (i) => (i === 0 ? { error: 'HTTP 502' } : quiet)).verdict).toBe('unreadable');
  });
});
