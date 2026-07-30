/**
 * Okta status adapter (Atom feed).
 *
 * Source: the legacy FeedBurner Atom feed. `status.okta.com/history.atom`
 * returns 401 (verified 2026-07-30), so the deprecated FeedBurner property is
 * the only working public source.
 *
 * PARSING NOTE: this extracts entries with targeted regex rather than a real
 * XML parser. That is a deliberate trade-off — the engine stays dependency-free
 * and runtime-agnostic (Workers have no built-in XML parser), and the failure
 * mode is safe: if the markup shape changes, no entries match and the adapter
 * reports UNKNOWN rather than guessing. It is pinned by a fixture. Do NOT
 * extend this into general-purpose XML handling.
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://status.okta.com';

/** A feed with no new entries for this long is suspected dead, not healthy. */
const STALE_AFTER_DAYS = 180;

/**
 * @param {string} xml
 * @returns {{title: string, updated: string, content: string}[]}
 */
function extractEntries(xml) {
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  return entries.map((e) => ({
    title: toPlainText((e.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [, ''])[1]),
    updated: (e.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ?? [, ''])[1].trim(),
    content: toPlainText((e.match(/<content[^>]*>([\s\S]*?)<\/content>/i) ?? [, ''])[1]),
  }));
}

/**
 * @param {unknown} xml raw Atom feed text
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseOktaAtom(xml, options) {
  const { vendor, now = () => new Date() } = options ?? {};
  if (typeof xml !== 'string' || !/<feed\b/i.test(xml)) {
    return unknownRecord(vendor, 'input was not an Atom feed', { now, sourceUrl: SOURCE_URL });
  }

  const entries = extractEntries(xml);
  if (entries.length === 0) {
    return unknownRecord(vendor, 'Atom feed contained no entries', { now, sourceUrl: SOURCE_URL });
  }

  const warnings = [];

  // Freshness check. A deprecated feed that quietly stops updating would
  // otherwise report "operational" forever -- the rot behind findings H6/H7.
  const newest = entries
    .map((e) => Date.parse(e.updated))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  if (newest !== undefined) {
    const ageDays = (now().getTime() - newest) / 86_400_000;
    if (ageDays > STALE_AFTER_DAYS) {
      warnings.push(
        `feed appears stale: no entries newer than ${Math.round(ageDays)} days (source is a deprecated FeedBurner property)`,
      );
    }
  }

  // Okta titles their resolutions "Resolved <something>".
  const unresolved = entries.filter((e) => !/^resolved\b/i.test(e.title.trim()));

  if (unresolved.length === 0) {
    return makeRecord({
      vendor,
      severity: SEVERITY.OPERATIONAL,
      description: 'All systems operational.',
      sourceUrl: SOURCE_URL,
      warnings,
      now,
    });
  }

  const primary = unresolved[0];
  const severe = /disruption|outage/i.test(primary.title) ? SEVERITY.PARTIAL_OUTAGE : SEVERITY.DEGRADED;

  return makeRecord({
    vendor,
    severity: severe,
    incidentName: primary.title,
    description: primary.content || primary.title,
    sourceUrl: SOURCE_URL,
    components: unresolved.slice(0, 5).map((e) => ({ name: e.title, severity: severe })),
    warnings,
    now,
  });
}
