import { describe, it, expect } from 'vitest';
import { parseBetterStackSections } from '../../src/engine/adapters/betterstack.js';

// CodeQL js/incomplete-multi-character-sanitization (#8): single-pass tag
// stripping lets nested/malformed markup survive one replace. The stripped
// text is a display label (render.js esc() is the XSS boundary), but the
// label should still come out clean.
describe('betterstack tag stripping strips to a fixpoint', () => {
  it('nested/malformed tags are fully removed from the label', () => {
    const html = `status-page__resource-name'><<b>span>Widget API<</b>/span></div>`;
    const sections = parseBetterStackSections(html);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).not.toMatch(/[<>]/);
    expect(sections[0].name).toContain('Widget API');
  });
});
