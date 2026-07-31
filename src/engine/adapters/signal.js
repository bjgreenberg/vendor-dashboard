/**
 * Signal status adapter.
 *
 * status.signal.org is a deliberately minimal static page — roughly 650 bytes,
 * a single glyph and one sentence: "Signal is up".
 *
 * PARSING NOTE: with no structure to key on, this matches that SENTENCE, which
 * is not the mistake audit finding H6 was. H6 tested a bare `/\boperational\b/`
 * against a whole document, and "operational" appeared seven times in unrelated
 * markup. "Signal is up" / "Signal is down" is a specific, unambiguous
 * assertion that exists only as the page's actual verdict — and anything that
 * matches neither yields UNKNOWN rather than a guess.
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord } from '../record.js';

const SOURCE_URL = 'https://status.signal.org';

/**
 * @param {unknown} html
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseSignal(html, options) {
  const { vendor, now } = options ?? {};
  if (typeof html !== 'string') {
    return unknownRecord(vendor, 'input was not HTML', { now, sourceUrl: SOURCE_URL });
  }

  if (/Signal\s+is\s+up/i.test(html)) {
    return makeRecord({
      vendor,
      severity: SEVERITY.OPERATIONAL,
      description: 'Signal is up.',
      sourceUrl: SOURCE_URL,
      now,
    });
  }

  if (/Signal\s+is\s+(down|having|experiencing)/i.test(html)) {
    return makeRecord({
      vendor,
      severity: SEVERITY.MAJOR_OUTAGE,
      incidentName: 'Service disruption',
      description: 'Signal reports it is not up.',
      sourceUrl: SOURCE_URL,
      now,
    });
  }

  return unknownRecord(
    vendor,
    'status page did not contain a recognisable verdict; its structure may have changed',
    { now, sourceUrl: SOURCE_URL },
  );
}
