/**
 * Shared status-record construction.
 *
 * Every adapter returns this same shape so the collector and the dashboard can
 * treat all vendors uniformly regardless of how exotic the upstream feed is.
 * Runtime-agnostic: pure, no platform APIs.
 */

import { SEVERITY } from './severity.js';

/**
 * @typedef {import('./severity.js').Severity} Severity
 * @typedef {{name: string, severity: Severity, description?: string}} ChildStatus
 */

/**
 * @typedef {object} StatusRecord
 * @property {string}        vendor
 * @property {string}        service
 * @property {Severity}      severity
 * @property {string}        incidentName
 * @property {string}        description
 * @property {string}        sourceUrl
 * @property {string}        checkedAt
 * @property {ChildStatus[]} components
 * @property {string[]}      warnings
 */

/**
 * @param {Partial<StatusRecord> & {vendor: string, now?: () => Date}} fields
 * @returns {StatusRecord}
 */
export function makeRecord(fields) {
  const { now = () => new Date() } = fields;
  return {
    vendor: fields.vendor,
    service: fields.service ?? fields.vendor,
    severity: fields.severity ?? SEVERITY.UNKNOWN,
    incidentName: fields.incidentName ?? '',
    description: fields.description ?? '',
    sourceUrl: fields.sourceUrl ?? '',
    checkedAt: now().toISOString(),
    components: fields.components ?? [],
    warnings: fields.warnings ?? [],
  };
}

/**
 * The record an adapter returns when it cannot understand its input.
 *
 * Fails closed (audit findings H4, H6, H7): an unreadable feed is uncertainty,
 * never health. Three separate vendors were reporting green-by-accident before
 * this rule was enforced uniformly.
 *
 * @param {string} vendor
 * @param {string} reason
 * @param {{now?: () => Date, sourceUrl?: string, service?: string}} [opts]
 * @returns {StatusRecord}
 */
export function unknownRecord(vendor, reason, opts = {}) {
  return makeRecord({
    vendor,
    service: opts.service,
    severity: SEVERITY.UNKNOWN,
    description: 'Status could not be determined.',
    sourceUrl: opts.sourceUrl ?? '',
    warnings: [reason],
    now: opts.now,
  });
}

/**
 * Strip markup and collapse whitespace for a plain-text summary.
 *
 * A display cleaner, NOT a sanitizer — the render layer escapes on output
 * (audit finding M4). Never inject this result into HTML unescaped.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function toPlainText(text) {
  if (typeof text !== 'string') return '';
  return (
    text
      .replace(/<[^>]*>/g, ' ')
      // Markdown emphasis/heading markers: some feeds (Google's) ship markdown
      // in a plain-text field, and the markers rendered literally on the card
      // (2026-08-28). Only the markers go — the words stay.
      .replace(/(\*\*|__)(?=\S)([^*_]+?)(?<=\S)\1/g, '$2')
      .replace(/(^|\s)#{1,6}\s+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
