import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { collect } from '../../src/engine/collect.js';
import { SEVERITY } from '../../src/engine/severity.js';

// Worklist #132, decided 2026-10-02: when part of a vendor could not be read,
// the row keeps the status that WAS verified, the card says what is missing,
// and each missing data centre or cloud shows as an unknown component. The row
// is `unknown` when a data centre the config names as required is the one
// missing. Before this, Concur read operational with three of its four data
// centres unread and nothing on the card said so.

const now = () => new Date('2026-10-02T12:00:00Z');
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../../config/vendors.json', import.meta.url), 'utf8'));
const vendor = (name) => config.vendors.find((v) => v.name === name);

const page = (body) => ({ ok: true, status: 200, text: async () => body });
const stall = () => { throw new Error('The operation was aborted due to timeout'); };
/** fetchFn from a map of url -> body | function; anything else gets `rest`. */
const fetchBy = (map, rest) => async (url) => {
  const hit = Object.hasOwn(map, url) ? map[url] : rest;
  return typeof hit === 'function' ? hit() : page(hit);
};
const one = async (v, fetchFn) => {
  const res = await collect({ vendors: [v] }, { fetchFn, now, retryDelayMs: 0 });
  return { res, row: res.records[0] };
};

describe('Concur — one document per data centre', () => {
  const concur = vendor('Concur');
  const [US2, EU2, APJ1, USG] = concur.statusUrls;
  const healthy = fixture('Concur-status-history-us2.json');
  const banner = fixture('Concur-banner.json'); // display: false

  it('all four read, banner quiet: operational, no note, read in full', async () => {
    const { res, row } = await one(concur, fetchBy({ [concur.bannerUrl]: banner }, healthy));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings).toEqual([]);
    expect(row.components.filter((c) => c.severity === SEVERITY.UNKNOWN)).toEqual([]);
    expect(res.incomplete).toEqual([]);
  });

  it('one data centre does not answer: the status stands, the card says which, and it shows as unknown', async () => {
    const { res, row } = await one(concur, fetchBy({ [EU2]: stall, [concur.bannerUrl]: banner }, healthy));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings[0]).toBe('1 of 4 data centres could not be read (EU2). The status shown is from the other 3.');
    expect(row.components).toContainEqual({ name: 'Data centre EU2', severity: SEVERITY.UNKNOWN, description: 'Could not be read.' });
    expect(res.incomplete).toEqual(['Concur']);
  });

  it('a data centre that answers 200 with no status in it is not a reading either', async () => {
    // The hole the reviews of PR #160 pinned: it parsed, so nothing noticed.
    const { res, row } = await one(concur, fetchBy({ [APJ1]: '{"success":true}', [concur.bannerUrl]: banner }, healthy));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings[0]).toBe('1 of 4 data centres could not be read (APJ1). The status shown is from the other 3.');
    expect(row.components).toContainEqual({ name: 'Data centre APJ1', severity: SEVERITY.UNKNOWN, description: 'Could not be read.' });
    expect(res.incomplete).toEqual(['Concur']);
  });

  it('only US2 answers (the case that read plain green): still the verified status, and the card counts what is missing', async () => {
    const { row } = await one(concur, fetchBy({ [EU2]: stall, [APJ1]: stall, [USG]: stall, [concur.bannerUrl]: banner }, healthy));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings[0]).toBe('3 of 4 data centres could not be read (EU2, APJ1, USG). The status shown is from the other 1.');
    expect(row.components.filter((c) => c.severity === SEVERITY.UNKNOWN).map((c) => c.name)).toEqual([
      'Data centre EU2',
      'Data centre APJ1',
      'Data centre USG',
    ]);
  });

  it('the US data centre answers with no status in it: the row is unknown, never judged from the others', async () => {
    // `dataCenters: ["US2"]` in config names the one that must be read. The
    // board judges from the United States.
    expect(concur.dataCenters).toEqual(['US2']);
    const { res, row } = await one(concur, fetchBy({ [US2]: '{"success":true}', [concur.bannerUrl]: banner }, healthy));
    expect(row.severity).toBe(SEVERITY.UNKNOWN);
    expect(row.warnings[0]).toBe("Concur's US2 data centre could not be read, so its status is not shown.");
    expect(res.incomplete).toEqual(['Concur']);
  });

  it('trouble in a data centre that WAS read still shows, with the note beside it', async () => {
    const degraded = JSON.stringify({ data: { Expense: { Service: 'Expense', 'Current Status': { status: 'degraded', incidents: [] } } } });
    const { row } = await one(concur, fetchBy({ [USG]: degraded, [EU2]: stall, [concur.bannerUrl]: banner }, healthy));
    expect(row.severity).toBe(SEVERITY.DEGRADED);
    expect(row.warnings[0]).toMatch(/^1 of 4 data centres could not be read \(EU2\)/);
  });

  describe('the issue banner', () => {
    it('is fetched, and a displayed banner is a floor: never plain green', async () => {
      const shown = JSON.stringify({ data: { display: true, text: { en: 'Issue Alert' } }, success: true });
      const calls = [];
      const { row } = await one(concur, async (url) => {
        calls.push(url);
        return page(url === concur.bannerUrl ? shown : healthy);
      });
      expect(calls).toContain(concur.bannerUrl);
      expect(row.severity).toBe(SEVERITY.DEGRADED);
      expect(row.incidentName).toBe('Status banner displayed');
    });

    it('a banner that could not be read is said so; the status from the data centres stands', async () => {
      const { res, row } = await one(concur, fetchBy({ [concur.bannerUrl]: stall }, healthy));
      expect(row.severity).toBe(SEVERITY.OPERATIONAL);
      expect(row.warnings[0]).toBe('The issue banner could not be read. The status shown does not include it.');
      expect(res.incomplete).toEqual(['Concur']);
    });

    it('a banner document with no display flag is not a reading', async () => {
      const { row } = await one(concur, fetchBy({ [concur.bannerUrl]: '{"success":true}' }, healthy));
      expect(row.warnings[0]).toBe('The issue banner could not be read. The status shown does not include it.');
    });

    it('a missing data centre and a missing banner are one note', async () => {
      const { row } = await one(concur, fetchBy({ [EU2]: stall, [concur.bannerUrl]: stall }, healthy));
      expect(row.warnings[0]).toBe(
        '1 of 4 data centres could not be read (EU2). The status shown is from the other 3. The issue banner could not be read. The status shown does not include it.',
      );
    });
  });

  it('every data centre named as required is one that is actually fetched', () => {
    const fetched = concur.statusUrls.map((u) => new URL(u).searchParams.get('data_center').toUpperCase());
    expect(fetched).toEqual(['US2', 'EU2', 'APJ1', 'USG']);
    for (const dc of concur.dataCenters) expect(fetched).toContain(dc);
  });
});

describe('Zscaler — one document per cloud', () => {
  const zscaler = vendor('Zscaler');
  const urls = zscaler.clouds.map((c) => c.url);
  const labels = zscaler.clouds.map((c) => c.label);
  const healthy = fixture('Zscaler-zdx.json');

  it('all eight read: no note, read in full', async () => {
    const { res, row } = await one(zscaler, fetchBy({}, healthy));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings).toEqual([]);
    expect(res.incomplete).toEqual([]);
  });

  it('only the first cloud answers: the card leads with the count, not with one cloud of seven', async () => {
    const { res, row } = await one(zscaler, fetchBy({ [urls[0]]: healthy }, stall));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings[0]).toBe(
      `7 of 8 clouds could not be read (${labels.slice(1, 5).join(', ')} and 3 more). The status shown is from the other 1.`,
    );
    expect(row.components.filter((c) => c.severity === SEVERITY.UNKNOWN)).toHaveLength(7);
    expect(res.incomplete).toEqual(['Zscaler']);
  });

  it('a cloud that answers 200 with nothing readable in it is counted as unread', async () => {
    const empty = JSON.stringify({ data: { severity: [], category: [] } });
    const { res, row } = await one(zscaler, fetchBy({ [urls[2]]: empty }, healthy));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings[0]).toBe(`1 of 8 clouds could not be read (${labels[2]}). The status shown is from the other 7.`);
    expect(res.incomplete).toEqual(['Zscaler']);
  });

  it('the first cloud answering with nothing readable is counted too, not passed off as read', async () => {
    const empty = JSON.stringify({ data: { severity: [], category: [] } });
    const { res, row } = await one(zscaler, fetchBy({ [urls[0]]: empty }, healthy));
    expect(row.severity).toBe(SEVERITY.OPERATIONAL);
    expect(row.warnings[0]).toBe(`1 of 8 clouds could not be read (${labels[0]}). The status shown is from the other 7.`);
    expect(res.incomplete).toEqual(['Zscaler']);
  });
});

describe('vendors with one extra document', () => {
  const NOTE = (what) => `${what} could not be read. The status shown does not include it.`;
  const sections = `<div class='status-page__resource-name'><img src="/status_pages/operational_small-abc.png">https://app.example.com</div>`;
  const cases = [
    ['Coalition (Control)', 'Coalition-instatus.json', '{"components":[]}', 'The component list'],
    ['Iorad', 'Iorad-sorryapp.json', '[]', 'The component list'],
    ['Stormboard', 'Stormboard-betterstack.html', '<div></div>', 'The list of monitored services'],
    ['Docusign', 'Docusign-components.json', '{}', 'The incident list'],
  ];

  for (const [name, primaryFixture, emptyBody, what] of cases) {
    const v = vendor(name);
    const extraUrl = v.componentsUrl ?? v.incidentsUrl;
    const primary = fixture(primaryFixture);

    it(`${name}: the extra document does not answer -> the status stands and the card says what is missing`, async () => {
      const { res, row } = await one(v, fetchBy({ [extraUrl]: stall }, primary));
      expect(row.severity).not.toBe(SEVERITY.UNKNOWN);
      expect(row.warnings[0]).toBe(NOTE(what));
      expect(res.incomplete).toEqual([name]);
    });

    it(`${name}: the extra document answers and is empty -> the same note, not silence`, async () => {
      const { res, row } = await one(v, fetchBy({ [extraUrl]: emptyBody }, primary));
      expect(row.severity).not.toBe(SEVERITY.UNKNOWN);
      expect(row.warnings[0]).toBe(NOTE(what));
      expect(res.incomplete).toEqual([name]);
    });
  }

  it('Stormboard: a sections fragment that lists a service is a reading, and carries no note', async () => {
    const v = vendor('Stormboard');
    const { res, row } = await one(v, fetchBy({ [v.componentsUrl]: sections }, fixture('Stormboard-betterstack.html')));
    expect(row.warnings).toEqual([]);
    expect(row.components).toHaveLength(1);
    expect(res.incomplete).toEqual([]);
  });

  it('Docusign: an incident list that is present and empty is a reading', async () => {
    const v = vendor('Docusign');
    const { res, row } = await one(v, fetchBy({ [v.incidentsUrl]: '{"incidents":[]}' }, fixture('Docusign-components.json')));
    expect(row.warnings).toEqual([]);
    expect(res.incomplete).toEqual([]);
  });

  it('Google: its product list only names things, so a missing one is recorded but puts no note on the card', async () => {
    const v = vendor('Google');
    const { res, row } = await one(v, fetchBy({ [v.componentsUrl]: stall }, fixture('Google-appsstatus.json')));
    expect(row.severity).not.toBe(SEVERITY.UNKNOWN);
    expect(row.warnings.join(' ')).not.toMatch(/could not be read/);
    expect(res.incomplete).toEqual(['Google']);
  });

  it('an unknown row carries its own reason, not a note about parts', async () => {
    const v = vendor('Iorad');
    const { row } = await one(v, fetchBy({ [v.url]: () => ({ ok: false, status: 404, text: async () => '' }), [v.componentsUrl]: stall }, '{}'));
    expect(row.severity).toBe(SEVERITY.UNKNOWN);
    expect(row.warnings).toEqual(['fetch returned HTTP 404']);
  });
});
