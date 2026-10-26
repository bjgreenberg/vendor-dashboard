import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeSvgContent } from '../../scripts/svg-active-content.mjs';

// fetch-logos.mjs writes vendor SVGs into the served static-asset directory,
// and static assets are served before the Worker runs, so the Worker's nonce
// CSP never covers them. A favicon is untrusted input like any other vendor
// content: an SVG carrying script, event handlers or external references is
// refused at fetch time (the existing refused-download path, so the current
// icon stays) and public/_headers gives the icon path a locked-down CSP as the
// second layer (test/worker/static-headers.test.js).
//
// The clean controls are SYNTHETIC on purpose. They reproduce the shapes the
// shipped marks use (clip-path and gradient url(#id) references, a <style>
// block, an xlink namespace with a fragment <use>, an XML prolog), but the
// marks themselves are not committed: redistributing vendor logos in a public
// repo is the act .gitignore exists to avoid. The disk-gated block at the end
// runs the same check over the real shipped set wherever it exists.

const wrap = (inner, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${attrs}>${inner}</svg>`;

const CLEAN = {
  'clip-path fragment reference': wrap(
    '<g clip-path="url(#a)"><path fill-rule="evenodd" d="M32 16c0-8.8-7.2-16-16-16S0 7.2 0 16s7.2 16 16 16 16-7.2 16-16Z" fill="#1A8CFF"/></g>' +
      '<defs><clipPath id="a"><path fill="#fff" d="M0 0h32v32H0z"/></clipPath></defs>',
    ' width="32" height="32" fill="none"',
  ),
  'gradient fills by fragment': wrap(
    '<path d="M0 0h32v32H0z" fill="url(#paint0_linear)"/>' +
      '<defs><linearGradient id="paint0_linear" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#0064E1"/><stop offset="1" stop-color="#0082FB"/></linearGradient></defs>',
  ),
  'style block with a commented-out dark scheme': wrap(
    '<style>#squircle { fill: #1f1e1e; } /* @media (prefers-color-scheme: dark) { #squircle { fill: #fff; } } */</style>' +
      '<g id="squircle"><rect width="32" height="32" rx="8"/></g>',
  ),
  'xml prolog, plain doctype, xlink namespace and a fragment <use>':
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16">' +
    '<defs><path id="p" d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Z"/></defs>' +
    '<use xlink:href="#p" fill="#24292f"/><use href="#p" transform="scale(.5)"/></svg>',
  'embedded raster image as a data: URI': wrap(
    '<image width="32" height="32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="/>',
  ),
  'words that merely contain "on" or "script"': wrap(
    '<title>Phone icon: online, scripted transcription</title><path id="icon" d="M0 0h1v1z" data-online="yes"/>',
  ),
};

// Every pattern the fetcher must refuse. Each planted SVG is otherwise a valid
// icon, so a pass here can only mean the check missed the planted content.
const REFUSED = {
  'a script element': wrap('<script>void 0</script><path d="M0 0h1v1z"/>'),
  'a script element in upper case': wrap('<SCRIPT type="text/ecmascript">void 0</SCRIPT>'),
  'a namespace-prefixed script element': wrap('<svg:script xmlns:svg="http://www.w3.org/2000/svg">void 0</svg:script>'),
  'an event-handler attribute on the root': wrap('<path d="M0 0h1v1z"/>', ' onload="void 0"'),
  'an event-handler attribute on a child': wrap('<rect width="1" height="1" onclick=\'void 0\'/>'),
  'an event handler after a quoted ">"': wrap('<path d="M0 0h1v1z"/>', ' aria-label="a>b" onmouseover="void 0"'),
  'a javascript: link': wrap('<a href="javascript:void 0"><path d="M0 0h1v1z"/></a>'),
  'a javascript: URL hidden by character references': wrap('<a href="&#106;ava&#x73;cript&#58;void 0"><path d="M0 0h1v1z"/></a>'),
  'a javascript: URL split by whitespace': wrap('<a href=" java\tscript:void 0"><path d="M0 0h1v1z"/></a>'),
  'a foreignObject': wrap('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
  'an iframe': wrap('<iframe src="about:blank"/>'),
  'an embed': wrap('<embed src="x.swf"/>'),
  'an object': wrap('<object data="x.html"/>'),
  'an external <image> href': wrap('<image href="https://example.com/x.png" width="1" height="1"/>'),
  'an external xlink:href': wrap('<image xlink:href="//example.com/x.png" width="1" height="1"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'),
  'an external href under a renamed xlink prefix': wrap('<image x:href="https://example.com/x.png"/>', ' xmlns:x="http://www.w3.org/1999/xlink"'),
  'a relative href': wrap('<image href="logo.png" width="1" height="1"/>'),
  'an SVG data: URI (it is not checked recursively)': wrap('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'),
  'a non-image data: URI': wrap('<a href="data:text/html,x"><path d="M0 0h1v1z"/></a>'),
  'a <use> pointing at another document': wrap('<use href="sprite.svg#icon"/>'),
  'a <use> pointing at a data: URI': wrap('<use href="data:image/png;base64,AAAA"/>'),
  'a CSS url() to a remote origin': wrap('<style>rect { fill: url(https://example.com/p.svg#g); }</style><rect width="1" height="1"/>'),
  'a style attribute loading a remote image': wrap('<rect width="1" height="1" style="fill: url(\'//example.com/x\')"/>'),
  'a CSS @import': wrap('<style>@import "https://example.com/x.css";</style>'),
  'an xml-stylesheet processing instruction':
    '<?xml version="1.0"?><?xml-stylesheet href="https://example.com/x.css"?>' + wrap('<path d="M0 0h1v1z"/>'),
  'an internal DTD subset declaring entities':
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>' + wrap('<text>&x;</text>'),
  'an XHTML-namespaced element': wrap('<h:img xmlns:h="http://www.w3.org/1999/xhtml" src="x"/>'),
  'an animation that rewrites an href': wrap('<a href="#a"><set attributeName="href" to="#b"/><path id="a" d="M0 0h1v1z"/></a>'),
  'an animation that sets an event handler': wrap('<animate attributeName="onclick" to="x"/>'),
  'an href the scanner cannot parse': wrap('<a href=unquoted><path d="M0 0h1v1z"/></a>'),
};

describe('activeSvgContent — what fetch-logos refuses to ship', () => {
  it.each(Object.entries(CLEAN))('accepts a clean icon: %s', (_name, svg) => {
    expect(activeSvgContent(svg)).toEqual([]);
  });

  it.each(Object.entries(REFUSED))('refuses %s', (_name, svg) => {
    const reasons = activeSvgContent(svg);
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('names what it found, once per kind', () => {
    const reasons = activeSvgContent(wrap('<script>1</script><script>2</script>', ' onload="x"'));
    expect(reasons).toContain('script element');
    expect(reasons).toContain('event-handler attribute');
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('checks every planted pattern (the suite cannot silently shrink)', () => {
    expect(Object.keys(REFUSED).length).toBeGreaterThanOrEqual(30);
    expect(Object.keys(CLEAN).length).toBeGreaterThanOrEqual(6);
  });
});

describe('fetch-logos.mjs uses the check on both paths into public/', () => {
  // neutralizeColorScheme once sat in this script as dead code, never called,
  // and a --force refetch shipped the defect it existed to stop. Pin the call
  // sites: the download (a refused SVG is a refused download) and the mirror
  // (a file restored into assets/icons by hand never went through download).
  const src = readFileSync('scripts/fetch-logos.mjs', 'utf8');

  it('imports the check', () => {
    expect(src).toMatch(/import\s*\{\s*activeSvgContent\s*\}\s*from\s*'\.\/svg-active-content\.mjs'/);
  });
  it('refuses inside download(), before anything is written', () => {
    const body = src.slice(src.indexOf('async function download('), src.indexOf('function neutralizeColorScheme('));
    expect(body).toMatch(/activeSvgContent\(/);
    expect(body).toMatch(/return null/);
  });
  it('re-checks assets/icons before mirroring into public/', () => {
    const mirror = src.indexOf("const PUB_DIR = join(REPO, 'public', 'service-status', 'icons')");
    const check = src.indexOf('activeSvgContent(', src.indexOf('function neutralizeColorScheme('));
    expect(mirror).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(mirror);
  });
});

// The real shipped set, wherever it exists (icons are a build artifact; a bare
// checkout skips this loudly, as logos.test.js does).
const DIRS = ['assets/icons', 'public/service-status/icons'];
const svgsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.svg')) : []);
const shipped = DIRS.flatMap((dir) => svgsIn(dir).map((f) => join(dir, f)));

describe.runIf(shipped.length > 0)('every shipped SVG passes the active-content check', () => {
  it.each(shipped)('%s', (file) => {
    expect(activeSvgContent(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
