/**
 * Vendor roll-up and progressive disclosure.
 *
 * Runtime-agnostic: pure functions, no platform APIs.
 *
 * Most vendors are a parent over many sub-services — Google covers Workspace,
 * GCP, Chat and Gmail; Cloudflare publishes 125 products. Listing every healthy
 * child is noise that buries the handful that matter. So:
 *
 *   - all children healthy  -> one collapsed parent row
 *   - anything unhealthy    -> parent row plus ONLY the affected children
 *
 * The full child list is always retained in the data; this module decides what
 * is worth a reader's attention. Scoping (`scope.js`) decides which children
 * count at all — the two compose: scope filters, roll-up summarises.
 */

import { SEVERITY, worst, rank, compareRecords } from './severity.js';

/**
 * @typedef {import('./severity.js').Severity} Severity
 */

/**
 * @typedef {object} ChildStatus
 * @property {string}   name
 * @property {Severity} severity
 * @property {string}   [description]
 */

/**
 * @typedef {object} VendorStatus
 * @property {string}        vendor
 * @property {Severity}      severity   worst of parent signal and children
 * @property {boolean}       collapsed  true when nothing needs breaking out
 * @property {ChildStatus[]} children   every child, healthy ones included
 */

/**
 * Roll a vendor's children up into a single parent status.
 *
 * `parentSeverity` lets a caller fold in a signal the child list does not carry
 * — typically the vendor's own page indicator. The result is never healthier
 * than either source, so a parent cannot report green while a child is down,
 * nor while the vendor itself says otherwise.
 *
 * @param {string} vendor
 * @param {ChildStatus[]} [children]
 * @param {{parentSeverity?: Severity}} [options]
 * @returns {VendorStatus}
 */
export function rollUp(vendor, children = [], options = {}) {
  const list = Array.isArray(children) ? children : [];
  const childSeverities = list.map((c) => c.severity);

  const severity = options.parentSeverity
    ? worst([options.parentSeverity, ...childSeverities])
    : worst(childSeverities);

  return {
    vendor,
    severity,
    collapsed: severity === SEVERITY.OPERATIONAL,
    children: list,
  };
}

/**
 * The children worth showing: none when the vendor is healthy, otherwise only
 * the ones that are not operational, most severe first then alphabetical.
 *
 * `UNKNOWN` children are surfaced deliberately. A sub-service that could not be
 * evaluated must never be swallowed by an otherwise-green parent — that is
 * audit finding H4 (fail closed) applied at the roll-up layer.
 *
 * @param {VendorStatus} vendorStatus
 * @returns {ChildStatus[]}
 */
export function visibleChildren(vendorStatus) {
  if (!vendorStatus || vendorStatus.collapsed) return [];
  return (vendorStatus.children ?? [])
    .filter((c) => rank(c.severity) > rank(SEVERITY.OPERATIONAL))
    .map((c) => ({ ...c, vendor: c.name }))
    .sort(compareRecords)
    .map(({ vendor: _drop, ...c }) => c);
}
