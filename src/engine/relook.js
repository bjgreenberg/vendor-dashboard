/**
 * Re-look policy: who may be looked at again, and what one re-look found.
 *
 * Pure, like the rest of the engine. The Worker supplies the waiting, the
 * second collect() and the write; the decisions live here so they can be
 * tested without a Worker, a clock or a database.
 */

import { SEVERITY } from './severity.js';
import { hasExtraDocuments } from './collect.js';

/**
 * The vendors of a batch that are worth looking at again.
 *
 * Everyone the batch marked waitable, except the vendors configured to read
 * more than one document. A re-look could never write those (see
 * classifyRelook), so asking them again would spend requests for nothing.
 * This is a saving, not the safety check.
 *
 * @param {object[]} vendors config entries the batch marked waitable
 * @returns {object[]}
 */
export function relookCandidates(vendors) {
  return vendors.filter((v) => !hasExtraDocuments(v));
}

/**
 * Sort the vendors of one re-look into what happens to each.
 *
 * THE RULE: a re-look may only improve a row. `recovered` is therefore only
 * the vendors read WHOLE, and from ONE document per source:
 *   - not in `incomplete`: every source answered and was understood;
 *   - not in `usedExtraDocuments`: no component list, catalogue, data-centre
 *     or cloud document was involved. Those can answer 200 and be empty, the
 *     adapters then fall back to the first document, and nothing can tell
 *     that partial reading from a whole one (worklist #132). This is the
 *     fail-closed half: an adapter that gains an extra document tomorrow is
 *     kept out of re-look writes without anyone having to remember a list;
 *   - a real status: the check on the severity is belt and braces, so a
 *     missing or misnamed `incomplete` can never let an unknown row through.
 *
 * @param {{records: any[], waitable: string[], incomplete: string[], usedExtraDocuments: string[]}} run
 *   a collect() result for `pending`
 * @param {object[]} pending the config entries that were collected
 * @returns {{recovered: any[], stillFailing: object[], gaveUp: object[]}}
 *   `recovered`: records to write. `stillFailing`: vendors still failing in a
 *   way a minute might fix. `gaveUp`: everything else (a stall that became a
 *   404, or a reading that cannot be vouched for): left for their batch.
 */
export function classifyRelook(run, pending) {
  const incomplete = new Set(run.incomplete);
  const usedExtra = new Set(run.usedExtraDocuments);
  const waitable = new Set(run.waitable);
  const recovered = run.records.filter(
    (r) => !incomplete.has(r.vendor) && !usedExtra.has(r.vendor) && r.severity !== SEVERITY.UNKNOWN,
  );
  const read = new Set(recovered.map((r) => r.vendor));
  const rest = pending.filter((v) => !read.has(v.name));
  return {
    recovered,
    stillFailing: rest.filter((v) => waitable.has(v.name)),
    gaveUp: rest.filter((v) => !waitable.has(v.name)),
  };
}
