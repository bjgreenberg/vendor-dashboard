/**
 * Re-look policy: who may be looked at again, and what one re-look found.
 *
 * Pure, like the rest of the engine. The Worker supplies the waiting, the
 * second collect() and the write; the decisions live here so they can be
 * tested without a Worker, a clock or a database.
 */

import { SEVERITY } from './severity.js';
import { readsSeveralVotingDocuments } from './collect.js';

/**
 * The vendors of a batch that may be looked at again.
 *
 * Everyone the batch marked waitable, except the vendors for which a full
 * reading cannot yet be told from a partial one (see
 * readsSeveralVotingDocuments). A re-look that wrote such a vendor could turn
 * a row green on part of the truth.
 *
 * @param {object[]} vendors config entries the batch marked waitable
 * @returns {object[]}
 */
export function relookCandidates(vendors) {
  return vendors.filter((v) => !readsSeveralVotingDocuments(v));
}

/**
 * Sort the vendors of one re-look into what happens to each.
 *
 * THE RULE: a re-look may only improve a row. `recovered` is therefore only
 * the vendors that were read IN FULL (collect() does not list them as
 * `incomplete`) with a real status. The check on the severity is belt and
 * braces: a missing or misnamed `incomplete` must never let an unknown row
 * through.
 *
 * @param {{records: any[], waitable: string[], incomplete: string[]}} run a collect() result for `pending`
 * @param {object[]} pending the config entries that were collected
 * @returns {{recovered: any[], stillFailing: object[], gaveUp: object[]}}
 *   `recovered`: records to write. `stillFailing`: vendors still failing in a
 *   way a minute might fix. `gaveUp`: not read in full, and no longer for a
 *   waitable reason (a stall that became a 404): left for their batch.
 */
export function classifyRelook(run, pending) {
  const incomplete = new Set(run.incomplete);
  const waitable = new Set(run.waitable);
  const recovered = run.records.filter(
    (r) => !incomplete.has(r.vendor) && r.severity !== SEVERITY.UNKNOWN,
  );
  const read = new Set(recovered.map((r) => r.vendor));
  const rest = pending.filter((v) => !read.has(v.name));
  return {
    recovered,
    stillFailing: rest.filter((v) => waitable.has(v.name)),
    gaveUp: rest.filter((v) => !waitable.has(v.name)),
  };
}
