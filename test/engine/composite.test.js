import { describe, it, expect } from 'vitest';
import { collect } from '../../src/engine/collect.js';
import { SEVERITY } from '../../src/engine/severity.js';

// Microsoft publishes four unrelated feeds plus Azure DevOps on another host.
// As five sibling rows they sorted apart alphabetically and read as five
// unrelated companies. A composite vendor merges them into one row with grouped
// components.
//
// The merge rules all follow from the governing rule: a row must never read
// healthier than the worst thing it actually checked.

const now = () => new Date('2026-08-01T01:00:00Z');

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

/** A composite whose sources are served by a routing fetch stub. */
const cfg = (sources) => ({
  vendors: [{ name: 'Microsoft', type: 'composite', pageUrl: 'https://status.example', sources }],
});

const CONSUMER = (status) => [
  { ServiceDisplayName: 'Outlook.com', Status: status },
  { ServiceDisplayName: 'OneDrive', Status: 'Operational' },
];
const AZURE = (status) => ({ Status: status, LastUpdatedTime: '2026-08-01T00:59:00+00:00' });

/** Route by URL so each source gets its own payload, or an error. */
const router = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => url.includes(k));
  if (!hit) throw new Error(`unrouted ${url}`);
  const v = hit[1];
  if (v instanceof Error) throw v;
  return v;
};

const SOURCES = [
  { type: 'microsoft-consumer', url: 'https://x/consumer', group: 'Consumer' },
  { type: 'azure-post', url: 'https://x/azure', group: 'Azure' },
];

const runWith = async (routes, sources = SOURCES) => {
  const res = await collect(cfg(sources), {
    fetchFn: router(routes),
    now,
    retryDelayMs: 0,
  });
  return res.records[0];
};

describe('composite vendor', () => {
  it('merges every source into one row, prefixed by group', async () => {
    const r = await runWith({
      consumer: json(CONSUMER('Operational')),
      azure: json(AZURE('Available')),
    });
    expect(r.vendor).toBe('Microsoft');
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components.map((c) => c.name)).toEqual([
      'Consumer · Outlook.com',
      'Consumer · OneDrive',
      'Azure',
    ]);
  });

  it('represents a single-status source as one component', async () => {
    // Azure returns a bare status with no components of its own. Without this
    // it would contribute severity invisibly -- a row that is degraded with
    // nothing in the expanded list explaining why.
    const r = await runWith({
      consumer: json(CONSUMER('Operational')),
      azure: json(AZURE('Degraded')),
    });
    expect(r.components.find((c) => c.name === 'Azure').severity).toBe(SEVERITY.DEGRADED);
  });

  it('takes the WORST severity across sources', async () => {
    // One healthy source must never mask a broken sibling.
    const r = await runWith({
      consumer: json(CONSUMER('Operational')),
      azure: json(AZURE('Unavailable')),
    });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.description).toMatch(/Affected: Azure/);
  });

  it('names every affected group, not just the worst', async () => {
    const r = await runWith({
      consumer: json(CONSUMER('Degraded')),
      azure: json(AZURE('Unavailable')),
    });
    expect(r.description).toMatch(/Consumer/);
    expect(r.description).toMatch(/Azure/);
  });

  // --- the failure paths. A dropped source is the starvation bug at vendor
  // scope: the row reads green while part of it was never checked.

  it('keeps a FAILED source visible as unknown rather than dropping it', async () => {
    const r = await runWith({
      consumer: json(CONSUMER('Operational')),
      azure: new Error('network down'),
    });
    expect(r.components.map((c) => c.name)).toContain('Azure');
    expect(r.components.find((c) => c.name === 'Azure').severity).toBe(SEVERITY.UNKNOWN);
  });

  it('a failed source makes the ROW unknown, never operational', async () => {
    const r = await runWith({
      consumer: json(CONSUMER('Operational')),
      azure: new Error('network down'),
    });
    expect(r.severity).toBe(SEVERITY.UNKNOWN);
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });

  it('a real outage still outranks an unknown sibling', async () => {
    // unknown > operational, but a confirmed outage is more severe still.
    const r = await runWith({
      consumer: json(CONSUMER('Unavailable')),
      azure: new Error('network down'),
    });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('surfaces each source warning tagged with its group', async () => {
    const r = await runWith({
      consumer: json(CONSUMER('Operational')),
      azure: json(AZURE('Available')),
    });
    expect(r.warnings.some((w) => w.startsWith('Consumer: '))).toBe(true);
  });

  it('refuses a composite with no sources rather than reporting health', async () => {
    const res = await collect(
      { vendors: [{ name: 'Microsoft', type: 'composite', sources: [] }] },
      { fetchFn: async () => json({}), now, retryDelayMs: 0 },
    );
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
  });

  it('describes a healthy row by the VENDOR\'S OWN name, not Microsoft\'s', async () => {
    // The healthy description hardcoded "Microsoft" from the first composite
    // vendor; a second composite (US Government) would have read "All N
    // monitored Microsoft services report healthy."
    const res = await collect(
      {
        vendors: [
          {
            name: 'US Government',
            type: 'composite',
            sources: [{ type: 'azure-post', url: 'https://x/azure', group: 'Login.gov' }],
          },
        ],
      },
      { fetchFn: async () => json(AZURE('Available')), now, retryDelayMs: 0 },
    );
    expect(res.records[0].description).toMatch(/US Government/);
    expect(res.records[0].description).not.toMatch(/Microsoft/);
  });

  it("a source's own verdict votes even when its DISPLAYED components read healthy", async () => {
    // A statuspage source can display at group level while scoped leaves vote
    // (VA APIs). The groups' rolled-up statuses come from the payload and can
    // read operational while the source's verified severity is an outage —
    // the row must take the record's verdict, not just the display list.
    const page = {
      status: { indicator: 'none' },
      components: [
        { id: 'g1', name: 'Some API', status: 'operational', group: true },
        { id: 'c1', name: 'Production Environment', status: 'major_outage', group: false, group_id: 'g1' },
      ],
    };
    const res = await collect(
      {
        vendors: [
          {
            name: 'V',
            type: 'composite',
            sources: [
              {
                type: 'statuspage',
                url: 'https://x/sp',
                group: 'G',
                componentLevel: 'group',
                scope: { components: ['Production Environment'] },
              },
            ],
          },
        ],
      },
      { fetchFn: async () => json(page), now, retryDelayMs: 0 },
    );
    expect(res.records[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('costs exactly one subrequest per source', async () => {
    // Consolidating rows must not change what the run costs -- the free-plan
    // ceiling is what started all of this.
    let calls = 0;
    await collect(cfg(SOURCES), {
      fetchFn: async (url) => {
        calls += 1;
        return url.includes('consumer') ? json(CONSUMER('Operational')) : json(AZURE('Available'));
      },
      now,
      retryDelayMs: 0,
    });
    expect(calls).toBe(SOURCES.length);
  });
});
