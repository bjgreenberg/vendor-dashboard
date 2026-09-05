import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { probeUrlsFor, secondOpinion, compare } from '../../scripts/truth-check/rules.mjs';

// The second opinion is deliberately dumb and deliberately NOT the adapter:
// it reads each vendor's own verdict the simplest way that vendor offers
// (page indicator, in-scope component states, an incident with no end) from
// the raw payload, and disagrees with the board only when the board renders
// `operational` while the vendor says otherwise. Fixtures are recorded
// vendor payloads, so every rule here is exercised against a real shape.
const fixture = (name) => JSON.parse(readFileSync(`test/fixtures/${name}`, 'utf8'));
const config = JSON.parse(readFileSync('config/vendors.json', 'utf8'));
const vendorNamed = (name) => config.vendors.find((v) => v.name === name);

describe('probeUrlsFor — which raw feeds the second opinion reads', () => {
  it('a plain statuspage vendor: its summary.json', () => {
    expect(probeUrlsFor(vendorNamed('Anthropic'))).toEqual([vendorNamed('Anthropic').url]);
  });
  it('oracle: the page-level status.json on the same host, not the 1.6 MB components feed', () => {
    expect(probeUrlsFor(vendorNamed('Oracle Cloud'))).toEqual(['https://ocistatus.oraclecloud.com/api/v2/status.json']);
  });
  it('a composite of statuspage sources: every source', () => {
    const gov = vendorNamed('US Government');
    expect(probeUrlsFor(gov)).toEqual(gov.sources.map((s) => s.url));
  });
  it('region-scoped or unsupported vendors are not covered (empty list, never a guess)', () => {
    expect(probeUrlsFor(vendorNamed('AWS'))).toEqual([]);
    expect(probeUrlsFor(vendorNamed('Discord'))).toEqual([]);
    expect(probeUrlsFor(vendorNamed('Microsoft'))).toEqual([]);
    expect(probeUrlsFor({ name: 'x', type: 'never-heard-of-it', url: 'https://x' })).toEqual([]);
  });
});

describe('secondOpinion — statuspage', () => {
  const sp = (name, payload, extra = {}) => secondOpinion({ name, type: 'statuspage', url: 'https://s/summary.json', ...extra }, { 'https://s/summary.json': payload });

  it('indicator none is fine; an open incident is evidence, not a vote (KnowBe4 precedent)', () => {
    const o = sp('KnowBe4', fixture('KnowBe4.json'), { componentLevel: 'group' });
    expect(o.covered).toBe(true);
    expect(o.verdict).toBe('fine');
    expect(o.evidence.join(' ')).toMatch(/indicator=none/);
    expect(o.evidence.join(' ')).toMatch(/open incident/);
  });
  it('a major indicator is trouble, with the incident named', () => {
    const o = sp('Anthropic', fixture('Anthropic-outage.json'));
    expect(o.verdict).toBe('trouble');
    expect(o.evidence.join(' ')).toMatch(/indicator=major/);
  });
  it('maintenance is trouble too — the board must not read operational during it', () => {
    const p = fixture('Anthropic.json');
    p.status.indicator = 'maintenance';
    expect(sp('Anthropic', p).verdict).toBe('trouble');
  });
  it('a missing indicator is unreadable, never fine', () => {
    expect(sp('Anthropic', { status: {} }).verdict).toBe('unreadable');
    expect(sp('Anthropic', null).verdict).toBe('unreadable');
    expect(sp('Anthropic', { error: 'HTTP 503' }).verdict).toBe('unreadable');
  });
  it('a group-scoped vendor is judged by its in-scope components, not the page indicator (Cloudflare)', () => {
    const cf = fixture('Cloudflare.json');
    expect(cf.status.indicator).toBe('minor'); // PoP re-routing; the settled decision ignores it
    const o = sp('Cloudflare', cf, { scope: { groups: ['Cloudflare Sites and Services'] } });
    expect(o.verdict).toBe('fine');
    expect(o.evidence.join(' ')).toMatch(/in-scope components/);
    cf.components.find((c) => c.group_id && c.name === 'Workers').status = 'partial_outage';
    expect(sp('Cloudflare', cf, { scope: { groups: ['Cloudflare Sites and Services'] } }).verdict).toBe('trouble');
  });
  it('a component-scoped vendor is judged by the named components only', () => {
    const p = fixture('Anthropic.json');
    const names = p.components.filter((c) => !c.group).map((c) => c.name);
    const scoped = { scope: { components: [names[0]] } };
    expect(sp('Anthropic', p, scoped).verdict).toBe('fine');
    p.components.find((c) => c.name === names[1]).status = 'major_outage'; // out of scope
    expect(sp('Anthropic', p, scoped).verdict).toBe('fine');
    p.components.find((c) => c.name === names[0]).status = 'degraded_performance';
    expect(sp('Anthropic', p, scoped).verdict).toBe('trouble');
  });
  it('a scope that matches nothing is unreadable — an empty selection never reads fine', () => {
    expect(sp('Anthropic', fixture('Anthropic.json'), { scope: { components: ['No Such Component'] } }).verdict).toBe('unreadable');
  });
});

describe('secondOpinion — the other covered platforms', () => {
  it('instatus: UP is fine, anything else is trouble, a missing page is unreadable', () => {
    const v = { name: 'Perplexity', type: 'instatus', url: 'https://p/summary.json' };
    expect(secondOpinion(v, { [v.url]: fixture('Perplexity-instatus.json') }).verdict).toBe('fine');
    expect(secondOpinion(v, { [v.url]: { page: { status: 'HASISSUES' } } }).verdict).toBe('trouble');
    expect(secondOpinion(v, { [v.url]: { page: { status: 'UNDERMAINTENANCE' } } }).verdict).toBe('trouble');
    expect(secondOpinion(v, { [v.url]: {} }).verdict).toBe('unreadable');
  });
  it('sorryapp: page.state operational is fine, anything else is trouble', () => {
    const v = { name: 'iorad', type: 'sorryapp', url: 'https://i/status.json' };
    expect(secondOpinion(v, { [v.url]: fixture('Iorad-sorryapp.json') }).verdict).toBe('fine');
    expect(secondOpinion(v, { [v.url]: { page: { state: 'degraded' } } }).verdict).toBe('trouble');
    expect(secondOpinion(v, { [v.url]: { page: {} } }).verdict).toBe('unreadable');
  });
  it('google: an incident with no end is trouble; a feed of closed incidents is fine (golden 2026-09-05)', () => {
    const v = vendorNamed('Google');
    const closed = fixture('Google-appsstatus-2026-09-05.json');
    expect(closed.every((i) => i.end)).toBe(true);
    expect(secondOpinion(v, { [v.url]: closed }).verdict).toBe('fine');
    const open = fixture('Google-appsstatus-open.json');
    const o = secondOpinion(v, { [v.url]: open });
    expect(o.verdict).toBe('trouble');
    expect(o.evidence.join(' ')).toMatch(/no end/);
    expect(secondOpinion(v, { [v.url]: { not: 'an array' } }).verdict).toBe('unreadable');
  });
  it('oracle: the page-level indicator', () => {
    const v = vendorNamed('Oracle Cloud');
    const [url] = probeUrlsFor(v);
    expect(secondOpinion(v, { [url]: { status: { indicator: 'none' } } }).verdict).toBe('fine');
    expect(secondOpinion(v, { [url]: { status: { indicator: 'major' } } }).verdict).toBe('trouble');
  });
  it('composite of statuspage sources: the worst source wins', () => {
    const gov = vendorNamed('US Government');
    // Each source gets its OWN recorded payload: two of the four are scoped
    // (cloud.gov groups, VA APIs' Production Environment) and a scope that
    // matches nothing is unreadable by design.
    const own = ['LoginGov-statuspage.json', 'SSA-statuspage.json', 'CloudGov-statuspage.json', 'VAAPIs-statuspage.json'];
    const bodies = Object.fromEntries(gov.sources.map((s, i) => [s.url, fixture(own[i])]));
    expect(secondOpinion(gov, bodies).verdict).toBe('fine');
    bodies[gov.sources[1].url] = fixture('Anthropic-outage.json');
    const o = secondOpinion(gov, bodies);
    expect(o.verdict).toBe('trouble');
    expect(o.evidence.join(' ')).toContain(gov.sources[1].group);
  });
  it('an uncovered vendor says so and never guesses', () => {
    const o = secondOpinion(vendorNamed('AWS'), {});
    expect(o).toMatchObject({ covered: false, verdict: 'uncovered' });
  });
});

describe('compare — the board against the second opinions', () => {
  const rec = (vendor, severity) => ({ vendor, severity });
  const op = (vendor, verdict, covered = true) => [vendor, { covered, verdict, evidence: [`${vendor}: evidence`], urls: [] }];

  it('false green is the one disagreement that alerts: board operational, vendor trouble', () => {
    const r = compare(
      [rec('A', 'operational'), rec('B', 'operational'), rec('C', 'degraded'), rec('D', 'unknown'), rec('E', 'operational')],
      new Map([op('A', 'trouble'), op('B', 'fine'), op('C', 'fine'), op('D', 'trouble'), op('E', 'trouble', false)]),
    );
    expect(r.falseGreen.map((x) => x.vendor)).toEqual(['A']);
    expect(r.falseGreen[0]).toMatchObject({ rendered: 'operational', evidence: ['A: evidence'] });
    expect(r.overCautious.map((x) => x.vendor)).toEqual(['C']); // we say degraded, vendor says fine — information, not an alert
    expect(r.covered).toBe(4); // E is uncovered
    expect(r.total).toBe(5);
    expect(r.agreed).toBe(1); // B only: D is the watchdog's business (unknown is covered but skipped, never 'agreed')
  });
  it('unreadable opinions are listed, never counted as agreement', () => {
    const r = compare([rec('A', 'operational')], new Map([op('A', 'unreadable')]));
    expect(r.unreadable).toEqual(['A']);
    expect(r.agreed).toBe(0);
    expect(r.falseGreen).toEqual([]);
  });
  it('a vendor on the board with no opinion at all is uncovered', () => {
    const r = compare([rec('A', 'operational')], new Map());
    expect(r.covered).toBe(0);
    expect(r.total).toBe(1);
  });
});
