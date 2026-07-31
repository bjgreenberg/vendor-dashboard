import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../../src/worker/render.js';

/** WCAG relative luminance. */
function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The badge text is 0.78rem — NORMAL text under WCAG, so 4.5:1 applies and the
// 3:1 large-text allowance does not.
const AA_NORMAL = 4.5;
const SITE_DARK = '#16191D';
const SITE_LIGHT = '#FAFAF7';

describe('WCAG 2.2 AA — status colour contrast', () => {
  const css = renderDashboard({ records: [], meta: null });

  /** Pull the colour a given class resolves to inside a dark-theme rule. */
  const darkColour = (cls) => {
    const re = new RegExp(`:root\\[data-theme="dark"\\][^{]*\\.${cls}[^{]*\\{[^}]*color:\\s*(#[0-9a-fA-F]{6})`);
    const m = css.match(re);
    return m ? m[1] : null;
  };

  for (const tone of ['ok', 'critical', 'major', 'minor', 'maintenance', 'unknown']) {
    it(`badge--${tone} meets AA on the dark background`, () => {
      const c = darkColour(`vs-badge--${tone}`);
      expect(c, `no dark-theme colour declared for vs-badge--${tone}`).toBeTruthy();
      expect(contrast(c, SITE_DARK)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  // Regression: maintenance (#2c5aa0, 2.58:1) and unknown (#6b7280, 3.65:1)
  // were missing from the dark block and leaked through from light mode.
  // `unknown` is shown whenever a vendor check fails, and the page defaults dark.
  it('REGRESSION: the two colours that previously leaked from light mode now pass', () => {
    expect(contrast('#2c5aa0', SITE_DARK)).toBeLessThan(AA_NORMAL); // the old value
    expect(contrast(darkColour('vs-badge--maintenance'), SITE_DARK)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast('#6b7280', SITE_DARK)).toBeLessThan(AA_NORMAL); // the old value
    expect(contrast(darkColour('vs-badge--unknown'), SITE_DARK)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('light-mode values still meet AA', () => {
    for (const c of ['#1f7a3d', '#b3261e', '#b3480f', '#8a5a00', '#2c5aa0', '#6b7280']) {
      expect(contrast(c, SITE_LIGHT)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});
