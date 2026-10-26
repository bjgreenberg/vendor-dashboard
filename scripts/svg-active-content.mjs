/**
 * SVG active-content check — the pure half of fetch-logos.mjs's SVG handling.
 *
 * A vendor favicon is untrusted input. An SVG is a document, not just an
 * image: opened at its own URL it can run script and load other resources on
 * the origin that serves it. The dashboard shows marks through <img>, where
 * browsers run nothing, but the files are also reachable directly, and they
 * are served as Workers static assets, before the Worker and its nonce CSP
 * run. So the fetcher ships only SVGs that are inert on their own: anything
 * that could execute, embed another document, or reach outside the file is
 * refused, and the existing mark stays (scripts/logo-manifest.mjs).
 *
 * This REFUSES; it never rewrites. A sanitiser has to be right about every
 * way a document can be malformed; a refusal only has to notice, and a false
 * positive costs one vendor its refreshed logo, not the board its safety.
 * Matching is deliberately broad for that reason (a `<script` inside a comment
 * is refused too). The static path's own CSP in public/_headers is the second
 * layer for anything a pattern list misses.
 *
 * Refused: script and other active or embedding elements (also under a
 * namespace prefix), event-handler attributes, javascript:/vbscript: URLs
 * (after decoding character references and dropping whitespace), any href or
 * xlink:href that is not a same-document `#fragment` or a raster data: image,
 * a <use> that is not a `#fragment`, CSS url() to anything else, CSS @import,
 * xml-stylesheet instructions, DTD internal subsets and entity declarations,
 * the XHTML namespace, and animations that target an href or a handler.
 *
 * @param {string} svg the file as text
 * @returns {string[]} what was found, one entry per kind; empty means clean
 */
export function activeSvgContent(svg) {
  const reasons = new Set();
  const raw = String(svg);
  const text = decodeReferences(raw);

  const ELEMENT = /<(?:[\w.-]+:)?(script|foreignobject|iframe|embed|object|applet|frame|frameset|handler|listener|base|link|meta)(?=[\s/>]|$)/gi;
  for (const m of text.matchAll(ELEMENT)) reasons.add(`${m[1].toLowerCase()} element`);

  if (/(^|[\s/"'])on[a-z]+\s*=/i.test(text)) reasons.add('event-handler attribute');

  if (/(java|vb)script:/i.test(text.replace(/[\s\p{Cc}]+/gu, ''))) reasons.add('script URL');

  // href / xlink:href / any-prefix:href. Parsed from the RAW text so the value
  // is exactly what the document says, then decoded before it is judged. An
  // href the pattern cannot parse (unquoted, say) is refused, never skipped.
  const HREF_ANY = /(?:^|[\s/"'])(?:[\w.-]+:)?href\s*=/gi;
  const HREF = /(?:^|[\s/"'])(?:[\w.-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const hrefs = [...raw.matchAll(HREF)].map((m) => decodeReferences(m[1] ?? m[2]).trim());
  if (hrefs.length !== [...raw.matchAll(HREF_ANY)].length) reasons.add('unparsed href');
  if (hrefs.some((v) => !isInternal(v))) reasons.add('external reference');

  for (const tag of raw.match(/<(?:[\w.-]+:)?use\b[^>]*>/gi) ?? []) {
    const values = [...tag.matchAll(HREF)].map((m) => decodeReferences(m[1] ?? m[2]).trim());
    if (values.some((v) => !v.startsWith('#'))) reasons.add('<use> outside the document');
  }

  const URL_ANY = /url\(/gi;
  const URL_FN = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;
  const urls = [...text.matchAll(URL_FN)].map((m) => m[2].trim());
  if (urls.length !== [...text.matchAll(URL_ANY)].length) reasons.add('unparsed CSS url()');
  if (urls.some((v) => !isInternal(v))) reasons.add('external CSS url()');

  if (/@import/i.test(text)) reasons.add('CSS @import');
  if (/<\?xml-stylesheet/i.test(text)) reasons.add('xml-stylesheet instruction');
  if (/<!ENTITY/i.test(text) || /<!DOCTYPE[^>[]*\[/i.test(text)) reasons.add('DTD internal subset');
  if (/http:\/\/www\.w3\.org\/1999\/xhtml/i.test(text)) reasons.add('XHTML namespace');
  if (/attributeName\s*=\s*["']\s*(?:[\w.-]+:)?(href|on[a-z]+)\s*["']/i.test(text)) reasons.add('animated href or handler');

  return [...reasons];
}

/** A same-document fragment, or an embedded RASTER image (an embedded SVG would need this check recursively). */
function isInternal(value) {
  return value.startsWith('#') || /^data:image\/(png|jpeg|jpg|gif|webp|avif)[;,]/i.test(value);
}

/** Decode XML character references and the five predefined entities. */
function decodeReferences(s) {
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => fromCode(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_, name) => NAMED[name.toLowerCase()]);
}

function fromCode(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '�';
  }
}
