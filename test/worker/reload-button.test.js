import { describe, it, expect } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboard } from '../../src/worker/render.js';

// Brian, 2026-11-16, from his phone: "a small reload or update button on the
// service status screen next to services impacted". His page read "Last
// collection 2:36 PM (2 hours ago)" while the live board had collected at
// 4:53 PM: the tab-return refresh (refresh.test.js) does not fire when iOS
// restores a frozen tab, so the reader needs a way to ask for fresh data.
//
// The contract:
//   - The button sits beside the headline ("N services impacted").
//   - It reloads only when pressed: a user-initiated reload, not a timer, so
//     WCAG 2.2.1 still holds (refresh.test.js keeps the no-timer rule).
//   - Without JavaScript it stays hidden: a button that does nothing must
//     not be shown (the same rule as the native Share button).
//   - The filter text survives, as for the tab-return reload (sessionStorage).

const record = {
  vendor: 'NetSuite',
  service: 'NetSuite',
  severity: 'partial_outage',
  incidentName: 'Password sync',
  description: 'Partial outage',
  sourceUrl: 'https://status.example.com/netsuite',
  components: [],
  warnings: [],
  checkedAt: '2026-11-16T20:36:00.000Z',
};
const page = () =>
  renderDashboard({
    records: [record],
    meta: { checked_at: '2026-11-16T20:36:00.000Z' },
    nonce: 'testnonce',
    now: () => new Date('2026-11-16T20:40:00.000Z'),
  });

function boot() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM(page(), { url: 'https://briangreenberg.net/service-status/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
  return { dom, errors };
}

describe('the board reload button', () => {
  it('sits beside the headline, in the same row', () => {
    const doc = new JSDOM(page()).window.document;
    const row = doc.querySelector('.vs-headrow');
    expect(row).not.toBeNull();
    expect(row.querySelector('.vs-headline').textContent).toContain('1 service impacted');
    const btn = row.querySelector('button.vs-reload');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.textContent).toContain('Reload');
  });

  it('is hidden in the markup, so it never shows without JavaScript', () => {
    const doc = new JSDOM(page()).window.document;
    expect(doc.querySelector('button.vs-reload').hidden).toBe(true);
  });

  it('is shown once the page script runs', () => {
    const { dom } = boot();
    expect(dom.window.document.querySelector('button.vs-reload').hidden).toBe(false);
  });

  it('reloads the page when pressed, and not before', () => {
    const { dom, errors } = boot();
    // jsdom does not navigate; a reload attempt reports "Not implemented".
    const before = errors.filter((m) => /not implemented/i.test(m)).length;
    expect(before).toBe(0);
    dom.window.document.querySelector('button.vs-reload').click();
    expect(errors.filter((m) => /not implemented/i.test(m)).length).toBe(1);
  });

  it('keeps the typed filter across the reload', () => {
    const { dom } = boot();
    const q = dom.window.document.getElementById('vs-q');
    expect(q).not.toBeNull();
    q.value = 'netsuite';
    q.dispatchEvent(new dom.window.Event('input'));
    expect(dom.window.sessionStorage.getItem('vs-filter')).toBe('netsuite');
  });
});
