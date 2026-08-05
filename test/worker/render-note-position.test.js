import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../../src/worker/render.js';

describe('how-to note placement', () => {
  it('explains how to use the board ABOVE the service list, not after it', () => {
    // Operator feedback 2026-08-04: the "Select a service name…" explainer sat
    // below ~46 rows, where nobody reads it until it is no longer needed.
    const html = renderDashboard({ records: [], meta: null, nonce: 'n' });
    const note = html.indexOf('Select a service name');
    const board = html.indexOf('id="vs-board"');
    expect(note).toBeGreaterThan(-1);
    expect(board).toBeGreaterThan(-1);
    expect(note).toBeLessThan(board);
  });
});
