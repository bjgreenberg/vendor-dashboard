import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../../src/worker/render.js';

// site-auditor (2026-08-04): favicon surface + imagery.dimensions. The board
// shares briangreenberg.net's origin, and declares its own tab icons plus the site's web manifest;
// every <img> carries intrinsic width/height so nothing shifts while loading.
describe('dashboard icon surface and image dimensions', () => {
  const html = renderDashboard({ records: [], meta: null, nonce: 'n' });

  it('declares an apple-touch-icon and the site\'s web manifest', () => {
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest"');
  });

  it('every img carries explicit width and height', () => {
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img, img).toMatch(/\bwidth="/);
      expect(img, img).toMatch(/\bheight="/);
    }
  });
});
