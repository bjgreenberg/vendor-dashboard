/**
 * Endpoint-rot classifier — the PURE half of the watchdog's diagnosis.
 *
 * Probe results in (shape below), classification + fix playbook out. Zero
 * network, zero platform APIs, so the precedence ladder is unit-testable
 * (test/scripts/classify.test.js). The probes live in diagnose-endpoint.mjs
 * and stay thin.
 *
 * Precedence: the earliest broken layer explains everything below it — a
 * dead DNS name makes the TLS and HTTP probes noise; a certificate that does
 * not cover the hostname (the SendGrid 2026-08-12 signature) makes the
 * redirect it precedes unsurprising.
 *
 * @typedef {object} Probe
 * @property {string} host
 * @property {{ok: boolean, chain: string[], error?: string}} [dns]
 * @property {{ok: boolean, matchesHost?: boolean, subject?: string, error?: string}} [tls]
 * @property {{ok: boolean, status?: number, redirects: {status: number, location: string}[],
 *             finalHost?: string, bodyIsJson?: boolean, error?: string}} [http]
 */

const PLAYBOOK = {
  'dns-failure':
    'The hostname no longer resolves. Find the vendor’s current status page and repoint config/vendors.json; if none exists, remove the row — a row with no data source reports health it never verified.',
  'tls-cert-mismatch':
    'The served certificate does not cover the hostname — the classic decommissioned-custom-domain signature (SendGrid, 2026-08-12: stale CNAME to Statuspage serving *.statuspage.io). The page has likely moved: find the new status page and repoint config, scoping if it is shared (worked example: PR #84).',
  decommissioned:
    'The endpoint redirects off-host — the page is gone. Find the vendor’s new status page and repoint config/vendors.json, scoping if it now shares another vendor’s page (worked example: PR #84).',
  'moved-but-redirecting':
    'The endpoint 302s to a NEW host that still serves the JSON feed — a rebrand or migration with a working redirect (seen live: status.anthropic.com → status.claude.com). The board keeps working through the redirect; update config/vendors.json to the new URL at leisure, before the vendor retires the redirect.',
  'http-client-error':
    'The endpoint answers 4xx. If 401/403 the feed may have gone private (see the Okta and Freshworks precedents in config); if 404 the path moved — re-derive the current API path from the status page’s network log.',
  'http-server-error':
    'The endpoint answers 5xx or refuses connections — possibly the vendor’s own outage. If it persists for days, treat as rot and look for a replacement endpoint.',
  'body-not-json':
    'The endpoint serves 200 but not JSON — the payload reshaped (often a JS-shell rewrite; see the Adobe precedent in config). Re-derive the real data URL from the page’s network log.',
  'endpoint-ok-likely-adapter-drift':
    'The endpoint is reachable and serves JSON — the rot is on OUR side: the adapter or scope no longer matches the payload (renamed components, new vocabulary). Diff a live payload against the recorded fixture and update the adapter, scope, or fixtures.',
};

/**
 * @param {Probe|null|undefined} probe
 * @returns {{classification: string, headline: string, suggestedFix: string}}
 */
export function classify(probe) {
  const host = probe?.host ?? '';
  const dns = probe?.dns ?? { ok: false, chain: [], error: 'no probe result' };
  const tls = probe?.tls ?? { ok: false };
  const http = probe?.http ?? { ok: false, redirects: [] };

  let classification;
  if (!dns.ok) {
    classification = 'dns-failure';
  } else if (tls.ok && tls.matchesHost === false) {
    classification = 'tls-cert-mismatch';
  } else if (http.finalHost && host && http.finalHost !== host) {
    // Off-host redirect: a terminal 200 that still serves JSON is a working
    // migration (rebrand); anything else is the page being gone.
    classification =
      http.status === 200 && http.bodyIsJson ? 'moved-but-redirecting' : 'decommissioned';
  } else if (typeof http.status === 'number' && http.status >= 500) {
    classification = 'http-server-error';
  } else if (typeof http.status === 'number' && http.status >= 400) {
    classification = 'http-client-error';
  } else if (http.ok && http.bodyIsJson === false) {
    classification = 'body-not-json';
  } else if (http.ok && http.bodyIsJson) {
    classification = 'endpoint-ok-likely-adapter-drift';
  } else {
    // DNS resolves but the HTTP probe never completed (timeout, refused,
    // reset): indistinguishable from a server-side failure at this layer.
    classification = 'http-server-error';
  }

  return {
    classification,
    headline: `Endpoint diagnosis: ${classification}`,
    suggestedFix: PLAYBOOK[classification],
  };
}
