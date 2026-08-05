import { describe, it, expect } from 'vitest';
import { stripRegionSuffix } from '../../src/engine/adapters/statuspage.js';

// CodeQL js/incomplete-sanitization (#7): region tokens are joined into a
// RegExp with only '/' escaped. Today's tokens carry no metacharacters, but
// the escape must cover all of them so a future token like "US (East)" can't
// silently corrupt the pattern.
describe('region-suffix regexes escape every metacharacter', () => {
  it('still strips the slash-bearing token', () => {
    expect(stripRegionSuffix('CDN - Hong Kong/China')).toBe('CDN');
  });
  it('ordinary names with parentheses survive untouched', () => {
    expect(stripRegionSuffix('Document List (MFA)')).toBe('Document List (MFA)');
  });
});
