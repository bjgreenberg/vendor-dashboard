import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../../src/worker/render.js';

// Tab-return refresh. The board's data changes every minute (one shard per
// cron tick) but a timed reload would wipe the filter and expanded components
// mid-reading — a WCAG 2.2.1 problem and plain rude. The contract instead:
//
//   - NO timed reload while the page is visible. Ever.
//   - Returning to a tab that has been HIDDEN for 5+ minutes reloads it, so
//     the board is never stale when someone actually looks at it.
//   - The filter text survives the reload (sessionStorage), because "I was
//     away six minutes" should not cost someone their typed query.
//   - The "minutes ago" timestamp ticks while visible, so even between
//     reloads the page never claims to be fresher than it is.
//
// The behavior lives in the nonce-gated inline script; these tests pin the
// script's load-bearing pieces the way share.test.js pins the share bar.

const html = () => renderDashboard({ records: [], meta: null, nonce: 'testnonce' });

describe('tab-return refresh contract', () => {
  it('reloads only from the visibilitychange handler, never a timer', () => {
    const doc = html();
    expect(doc).toContain("addEventListener('visibilitychange'");
    expect(doc).toContain('location.reload()');
    // No setInterval/setTimeout may call reload: the only reload must be
    // guarded by the hidden-duration check.
    const reloadSites = [...doc.matchAll(/location\.reload\(\)/g)];
    expect(reloadSites).toHaveLength(1);
    expect(doc).toMatch(/hiddenAt[\s\S]{0,200}location\.reload\(\)/);
  });

  it('uses a 5-minute hidden threshold', () => {
    expect(html()).toContain('RELOAD_AFTER_HIDDEN_MS = 5 * 60 * 1000');
  });

  it('persists and restores the filter text across the reload', () => {
    const doc = html();
    expect(doc).toContain("sessionStorage.setItem('vs-filter'");
    expect(doc).toContain("sessionStorage.getItem('vs-filter')");
  });

  it('ticks the relative age while visible', () => {
    const doc = html();
    // The ago-text updater must re-run on an interval — but must not reload.
    expect(doc).toMatch(/setInterval\([\s\S]{0,400}renderAge/);
  });
});
