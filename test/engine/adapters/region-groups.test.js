import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStatuspage } from '../../../src/engine/adapters/statuspage.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Reported 2026-08-04: Discord's card lists many geographies. Its payload
// mixes 8 ungrouped GLOBAL services (API, Gateway, Payments…) with a "Voice"
// group whose 15 leaves are PoPs (Tokyo, Singapore, São Paulo, US East…).
// Group mode is the wrong tool here — it would show the three groups and DROP
// the ungrouped services, hiding the API outage that made the row red.
//
// So: scope.regionGroups names the groups whose leaves are geographies and
// lists the ones that VOTE, under the board's US vantage point. Everything
// else (ungrouped services, other groups) votes normally. Region leaves stay
// on the card, prefixed with their group so a reader knows why a city is in
// a list of services — they inform, they do not vote.

const payload = JSON.parse(
  readFileSync(new URL('../../fixtures/Discord-api-outage.json', import.meta.url), 'utf8'),
);
const now = () => new Date('2026-08-04T15:00:00Z');
const US_VOICE = {
  scope: { regionGroups: { Voice: ['Atlanta', 'US Central', 'US East', 'US South', 'US West'] } },
};

/** Flip one component's status in a copy of the fixture. */
const withStatus = (name, status) => {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.components.find((c) => c.name === name && !c.group).status = status;
  return copy;
};

describe('region groups: geographies inform, US ones vote', () => {
  it('a GLOBAL service outage still reddens the row', () => {
    // The fixture has API in major_outage — that is not a geography, and it
    // must keep voting.
    const r = parseStatuspage(payload, { vendor: 'Discord', ...US_VOICE, now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('a NON-US voice region does not redden the row', () => {
    const healthy = withStatus('API', 'operational');
    const broken = JSON.parse(JSON.stringify(healthy));
    broken.components.find((c) => c.name === 'Hong Kong').status = 'major_outage';
    const r = parseStatuspage(broken, { vendor: 'Discord', ...US_VOICE, now });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('but it still appears on the card, labelled with its group', () => {
    const healthy = withStatus('API', 'operational');
    healthy.components.find((c) => c.name === 'Hong Kong').status = 'major_outage';
    const r = parseStatuspage(healthy, { vendor: 'Discord', ...US_VOICE, now });
    const hk = r.components.find((c) => c.name === 'Voice · Hong Kong');
    expect(hk).toBeDefined();
    expect(hk.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('a US voice region DOES redden the row', () => {
    const healthy = withStatus('API', 'operational');
    healthy.components.find((c) => c.name === 'US East').status = 'major_outage';
    const r = parseStatuspage(healthy, { vendor: 'Discord', ...US_VOICE, now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('non-region groups keep voting — a broken client is not a geography', () => {
    const healthy = withStatus('API', 'operational');
    healthy.components.find((c) => c.name === 'iOS').status = 'partial_outage';
    const r = parseStatuspage(healthy, { vendor: 'Discord', ...US_VOICE, now });
    expect(r.severity).toBe(SEVERITY.PARTIAL_OUTAGE);
  });

  it('warns when a configured voting region matches nothing live', () => {
    const r = parseStatuspage(payload, {
      vendor: 'Discord',
      scope: { regionGroups: { Voice: ['US East', 'Atlantis'] } },
      now,
    });
    expect(r.warnings.join(' ')).toMatch(/Atlantis/);
  });

  it('unscoped behaviour is unchanged: every leaf votes', () => {
    const healthy = withStatus('API', 'operational');
    healthy.components.find((c) => c.name === 'Hong Kong').status = 'major_outage';
    const r = parseStatuspage(healthy, { vendor: 'Discord', now });
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });
});
