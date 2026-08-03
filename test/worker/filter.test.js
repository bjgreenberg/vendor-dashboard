import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderDashboard } from '../../src/worker/render.js';

// Reported 2026-08-03: typing "google" returned Calendly, Google, Oracle
// Cloud and Seismic; "Microsoft" returned IBM Cloud, Microsoft and Oracle
// Cloud. Every one of those is a REAL match — Calendly publishes a "Google
// Analytics" component, Oracle publishes "Oracle Database@Google Cloud",
// Seismic "Google Drive Sync", IBM "Microsoft SQL Server 2022…" — and
// matching component names is the feature that lets "gmail" find Google.
//
// The defect is that the board never says WHY those cards matched, and it
// buried the vendor you actually searched for below alphabetical neighbours.
// So: the vendor whose NAME matches sorts first, and a card matched only on
// its components explains itself.
//
// These run the real inline script in jsdom rather than grepping its source,
// because the thing under test is behavior, not text.

const record = (vendor, components) => ({
  vendor,
  service: vendor,
  severity: 'operational',
  incidentName: '',
  description: 'All good',
  sourceUrl: `https://status.example.com/${vendor.toLowerCase()}`,
  components: components.map((name) => ({ name, severity: 'operational', description: '' })),
  warnings: [],
  checkedAt: '2026-08-03T16:00:00.000Z',
});

/** Render, boot in jsdom, type a term, return the resulting board state. */
function filterBoard(term) {
  const html = renderDashboard({
    records: [
      record('Calendly', ['Google Analytics', 'Scheduling']),
      record('Google', ['Google Calendar', 'Gmail']),
      record('Oracle Cloud', ['Oracle Database@Google Cloud']),
      record('Seismic', ['Google Drive Sync']),
      record('Zoom', ['Meetings']),
    ],
    meta: { checked_at: '2026-08-03T16:00:00.000Z', total: 5, impacted: 0, unknown: 0 },
    nonce: 'testnonce',
  });
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const { document } = dom.window;
  const input = document.getElementById('vs-q');
  input.value = term;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const visible = [...document.querySelectorAll('[data-search]')].filter((c) => !c.hidden);
  return {
    dom,
    document,
    visibleVendors: visible.map((c) => c.id),
    orderOf: (id) => document.getElementById(id)?.style.order ?? '',
    whyOn: (id) => document.getElementById(id)?.querySelector('.vs-why')?.textContent?.trim() ?? '',
    status: document.getElementById('vs-qstatus').textContent,
  };
}

describe('filter explains itself', () => {
  it('still matches component names, which is the point of the feature', () => {
    const r = filterBoard('google');
    expect(r.visibleVendors.sort()).toEqual(
      ['calendly', 'google', 'oracle-cloud', 'seismic'].sort(),
    );
  });

  it('puts the vendor whose NAME matches first', () => {
    const r = filterBoard('google');
    // Grid `order`: name matches get a lower order than component-only ones.
    expect(Number(r.orderOf('google'))).toBeLessThan(Number(r.orderOf('calendly') || 0));
  });

  it('tells the reader why a component-only match is on the board', () => {
    const r = filterBoard('google');
    expect(r.whyOn('calendly')).toMatch(/Google Analytics/);
    expect(r.whyOn('seismic')).toMatch(/Google Drive Sync/);
    expect(r.whyOn('oracle-cloud')).toMatch(/Oracle Database@Google Cloud/);
  });

  it('does not explain the vendor you actually searched for', () => {
    // Its own name is the reason; a "matches" line there would be noise.
    expect(filterBoard('google').whyOn('google')).toBe('');
  });

  it('clears the explanation and the ordering when the filter empties', () => {
    const r = filterBoard('google');
    const input = r.document.getElementById('vs-q');
    input.value = '';
    input.dispatchEvent(new r.dom.window.Event('input', { bubbles: true }));
    expect(r.document.querySelectorAll('.vs-why').length).toBe(0);
    expect(r.orderOf('calendly')).toBe('');
    expect([...r.document.querySelectorAll('[data-search]')].every((c) => !c.hidden)).toBe(true);
  });

  it('counts matches in the status line', () => {
    expect(filterBoard('google').status).toBe('4 services match');
    expect(filterBoard('zoom').status).toBe('1 service matches');
  });
});
