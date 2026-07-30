/**
 * Apple system status adapter.
 *
 * Source: https://www.apple.com/support/systemstatus/data/system_status_en_US.js
 *
 * Historically this endpoint served JS-wrapped JSON, which is why the
 * predecessor sliced between the first `{` and last `}`. It now returns plain
 * JSON; the tolerant extraction is retained because it costs nothing and still
 * handles the wrapped form if Apple reverts.
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://www.apple.com/support/systemstatus/';

/**
 * Accept either a parsed object or raw text that may be JS-wrapped.
 * @param {unknown} input
 * @returns {any|null}
 */
export function coerceApplePayload(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string') return null;
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(input.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} payload
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseApple(payload, options) {
  const { vendor, now } = options ?? {};
  const data = coerceApplePayload(payload);
  if (!data || !Array.isArray(data.services)) {
    return unknownRecord(vendor, 'payload had no services array', { now, sourceUrl: SOURCE_URL, service: 'Apple Services' });
  }

  const affected = data.services.filter((s) =>
    Array.isArray(s?.events) &&
    s.events.some((e) => String(e?.eventStatus ?? '').toLowerCase() !== 'resolved' && e?.eventStatus),
  );

  const components = affected.map((s) => ({
    name: String(s?.serviceName ?? 'Unknown service'),
    severity: SEVERITY.DEGRADED,
    description: toPlainText(s?.events?.[0]?.messages?.[0]?.message ?? ''),
  }));

  if (components.length === 0) {
    return makeRecord({
      vendor,
      service: 'Apple Services',
      severity: SEVERITY.OPERATIONAL,
      description: 'All services normal.',
      sourceUrl: SOURCE_URL,
      now,
    });
  }

  return makeRecord({
    vendor,
    service: 'Apple Services',
    severity: SEVERITY.DEGRADED,
    incidentName: 'Active issue',
    description: `Affected: ${components.map((c) => c.name).slice(0, 3).join(', ')}.`,
    sourceUrl: SOURCE_URL,
    components,
    now,
  });
}
