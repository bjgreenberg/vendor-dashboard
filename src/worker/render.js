/**
 * Dashboard rendering.
 *
 * SECURITY — audit finding M4. Every field rendered here is third-party content
 * from ~35 vendor status pages: incident titles, descriptions, component names.
 * A compromised or merely sloppy vendor page is untrusted input, and this is the
 * boundary where it enters a public site. Therefore:
 *
 *   - EVERY interpolated value goes through `esc()`. No exceptions.
 *   - No vendor HTML is ever rendered; markup arrives as text and stays text.
 *   - A per-response nonce gates the one inline script; the CSP forbids
 *     everything else.
 *
 * The predecessor's `stripHtml_` was a display cleaner mistaken for a sanitizer.
 * It was harmless writing into a spreadsheet cell and would not have been here.
 */

/** The only host permitted to be indexed. */
export const CANONICAL_HOST = 'briangreenberg.net';

/** Severity -> presentation. Order matches the sort ranking. */
const PRESENTATION = {
  major_outage: { label: 'Major outage', tone: 'critical', symbol: '●' },
  partial_outage: { label: 'Partial outage', tone: 'major', symbol: '◐' },
  degraded: { label: 'Degraded', tone: 'minor', symbol: '◑' },
  unknown: { label: 'Unknown', tone: 'unknown', symbol: '?' },
  maintenance: { label: 'Maintenance', tone: 'maintenance', symbol: '⚙' },
  operational: { label: 'Operational', tone: 'ok', symbol: '○' },
};

/**
 * Escape for HTML text and attribute contexts.
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {{records: any[], meta: any, basePath?: string, nonce?: string}} input
 * @returns {string} complete HTML document
 */
export function renderDashboard({
  records = [],
  meta = null,
  nonce = '',
  now = () => new Date(),
  host = CANONICAL_HOST,
}) {
  // Only the canonical host may be indexed. The workers.dev URL is a backend
  // address; letting a search engine index it would create a duplicate that
  // competes with the real page. Canonical still points home from everywhere,
  // which is exactly what canonical is for.
  const indexable = host === CANONICAL_HOST;
  const impacted = records.filter(
    (r) => r.severity !== 'operational' && r.severity !== 'unknown',
  ).length;
  const unknown = records.filter((r) => r.severity === 'unknown').length;

  // An EMPTY board is not a healthy board. Zero records means nothing was
  // checked, and rendering that as "All systems operational" is precisely the
  // false-green failure this rewrite exists to eliminate (findings H1, H4, H6,
  // H7). Caught on the first live deploy, 2026-07-31, before any data existed.
  const empty = records.length === 0;

  // Staleness is the dead-man's switch for our OWN collector. If the cron stops
  // firing, the last snapshot would otherwise keep rendering as current — the
  // same silent rot, one layer up. Two collection intervals is the threshold:
  // one missed run is noise, two is a signal.
  const STALE_AFTER_MS = 2 * 15 * 60 * 1000;
  const checkedAtMs = meta?.checked_at ? Date.parse(meta.checked_at) : NaN;
  const stale =
    !Number.isNaN(checkedAtMs) && now().getTime() - checkedAtMs > STALE_AFTER_MS;

  const headline = empty
    ? 'No status data — awaiting first collection'
    : impacted > 0
      ? `${impacted} service${impacted === 1 ? '' : 's'} impacted`
      : unknown > 0
        ? `All monitored services operational (${unknown} unchecked)`
        : 'All systems operational';

  const headlineTone = empty ? 'headline--unknown' : impacted > 0 ? 'headline--impacted' : '';

  const staleBanner = stale
    ? `<p class="stale" role="status">This data may be stale — the last successful collection was ${esc(meta.checked_at)}, more than two update intervals ago.</p>`
    : '';

  const rows = records.map((r) => renderRow(r)).join('\n');

  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service Status — live status for ${esc(records.length)} cloud services</title>
<meta name="description" content="Live operational status for ${esc(records.length)} cloud and SaaS services, refreshed every 15 minutes from each vendor's own public status endpoint.">
<meta name="robots" content="${indexable ? 'index, follow' : 'noindex, nofollow'}">
<link rel="canonical" href="https://briangreenberg.net/service-status">
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#board">Skip to status board</a>
<header class="head">
  <div class="head__row">
    <h1>Service Status</h1>
    <div class="theme" role="group" aria-label="Colour theme">
      <button type="button" data-theme-set="system" aria-pressed="true">System</button>
      <button type="button" data-theme-set="light" aria-pressed="false">Light</button>
      <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
    </div>
  </div>
  <p class="headline ${headlineTone}">${esc(headline)}</p>
  ${staleBanner}
  <p class="meta">
    ${meta?.checked_at ? `Last checked <time datetime="${esc(meta.checked_at)}">${esc(meta.checked_at)}</time>.` : 'No collection has run yet.'}
    Updates every 15 minutes.
  </p>
  <div class="search">
    <label for="q">Filter services</label>
    <input id="q" type="search" autocomplete="off" placeholder="Type to filter&hellip;"
           aria-describedby="qhelp" aria-controls="board">
    <p id="qhelp" class="hint">Matches vendor and affected service names.</p>
    <p id="qstatus" class="hint" role="status" aria-live="polite"></p>
  </div>
</header>

<main id="board" class="board">
${rows || '<p class="empty">No status has been collected yet. The collector runs every 15 minutes; if this persists, the scheduled job is not running.</p>'}
</main>

<footer class="foot">
  <p>Monitoring ${esc(records.length)} services. Status is read from each vendor&rsquo;s own public status endpoint.</p>
</footer>

<script${nonce ? ` nonce="${esc(nonce)}"` : ''}>
(function () {
  var root = document.documentElement;
  var KEY = 'vendor-dashboard-theme';

  // Appearance is a PER-DEVICE preference, so it lives in localStorage and is
  // never synced. Default is System, which follows prefers-color-scheme.
  function apply(mode) {
    root.setAttribute('data-theme', mode);
    document.querySelectorAll('[data-theme-set]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === mode));
    });
  }
  try { apply(localStorage.getItem(KEY) || 'system'); } catch (e) { apply('system'); }

  document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-theme-set');
      try { localStorage.setItem(KEY, mode); } catch (e) {}
      apply(mode);
    });
  });

  var q = document.getElementById('q');
  var status = document.getElementById('qstatus');
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-search]'));
  if (q) {
    q.addEventListener('input', function () {
      var term = q.value.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (card) {
        var hit = !term || card.getAttribute('data-search').indexOf(term) !== -1;
        card.hidden = !hit;
        if (hit) shown++;
      });
      status.textContent = term
        ? shown + (shown === 1 ? ' service matches' : ' services match')
        : '';
    });
  }
})();
</script>
</body>
</html>`;
}

/**
 * One vendor card. Healthy vendors render collapsed; unhealthy ones break out
 * only their affected children.
 * @param {any} record
 */
function renderRow(record) {
  const p = PRESENTATION[record.severity] ?? PRESENTATION.unknown;
  const children = (record.components ?? []).filter((c) => c.severity !== 'operational');
  const healthyCount = (record.components ?? []).length;

  // Search haystack covers the vendor and any broken-out child names.
  const haystack = [record.vendor, record.service, ...children.map((c) => c.name)]
    .join(' ')
    .toLowerCase();

  const detail =
    children.length > 0
      ? `<ul class="children">${children
          .map(
            (c) => `<li class="child">
        <span class="dot dot--${esc(PRESENTATION[c.severity]?.tone ?? 'unknown')}" aria-hidden="true">${esc(PRESENTATION[c.severity]?.symbol ?? '?')}</span>
        <span class="child__name">${esc(c.name)}</span>
        <span class="child__state">${esc(PRESENTATION[c.severity]?.label ?? c.severity)}</span>
      </li>`,
          )
          .join('')}</ul>`
      : record.severity === 'operational' && healthyCount > 0
        ? `<p class="allclear">${esc(healthyCount)} service${healthyCount === 1 ? '' : 's'} checked, all healthy.</p>`
        : '';

  const warnings = (record.warnings ?? []).length
    ? `<p class="warn">${esc(record.warnings[0])}</p>`
    : '';

  return `<article class="card card--${esc(p.tone)}" data-search="${esc(haystack)}">
  <div class="card__head">
    <span class="dot dot--${esc(p.tone)}" aria-hidden="true">${esc(p.symbol)}</span>
    <h2 class="card__name">${esc(record.service || record.vendor)}</h2>
    <span class="badge badge--${esc(p.tone)}">${esc(p.label)}</span>
  </div>
  ${record.incidentName ? `<p class="incident">${esc(record.incidentName)}</p>` : ''}
  <p class="desc">${esc(record.description)}</p>
  ${detail}
  ${warnings}
</article>`;
}

/**
 * Styles.
 *
 * Semantic tokens only — no raw hex in component rules. Both themes are defined
 * via prefers-color-scheme AND an explicit data-theme override, so the toggle
 * wins in both directions. Contrast pairs are chosen to clear WCAG 2.2 AA.
 */
const STYLES = `
:root {
  --bg: #ffffff; --surface: #f6f7f9; --border: #d6dae1;
  --text: #16191d; --text-dim: #5a6472;
  --ok: #1f7a3d; --minor: #8a5a00; --major: #b3480f; --critical: #b3261e;
  --maintenance: #2c5aa0; --unknown: #5a6472;
  --focus: #0b5fff;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1216; --surface: #171b21; --border: #2b323b;
    --text: #e9edf2; --text-dim: #a3adba;
    --ok: #52c47a; --minor: #e0a53a; --major: #f08a4b; --critical: #ff6b61;
    --maintenance: #7aa7f0; --unknown: #a3adba;
    --focus: #6ea8ff;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1216; --surface: #171b21; --border: #2b323b;
  --text: #e9edf2; --text-dim: #a3adba;
  --ok: #52c47a; --minor: #e0a53a; --major: #f08a4b; --critical: #ff6b61;
  --maintenance: #7aa7f0; --unknown: #a3adba;
  --focus: #6ea8ff;
}
:root[data-theme="light"] {
  --bg: #ffffff; --surface: #f6f7f9; --border: #d6dae1;
  --text: #16191d; --text-dim: #5a6472;
  --ok: #1f7a3d; --minor: #8a5a00; --major: #b3480f; --critical: #b3261e;
  --maintenance: #2c5aa0; --unknown: #5a6472;
  --focus: #0b5fff;
}

* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 1rem 4rem;
  background: var(--bg); color: var(--text);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.skip {
  position: absolute; left: -9999px;
}
.skip:focus {
  left: 1rem; top: 1rem; z-index: 10; padding: .75rem 1rem;
  background: var(--surface); color: var(--text); border-radius: var(--radius);
}
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.head { max-width: 64rem; margin: 0 auto; padding: 2rem 0 1rem; }
.head__row { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; }
h1 { font-size: clamp(1.5rem, 4vw, 2rem); margin: 0; }
.headline { font-size: 1.1rem; font-weight: 600; margin: 1rem 0 .25rem; color: var(--ok); }
.headline--impacted { color: var(--critical); }
.headline--unknown { color: var(--unknown); }
.stale {
  margin: .5rem 0; padding: .6rem .8rem; font-size: .875rem;
  color: var(--minor); background: var(--surface);
  border: 1px solid var(--minor); border-radius: var(--radius);
}
.meta, .hint { color: var(--text-dim); font-size: .875rem; margin: .25rem 0; }

.theme { display: flex; gap: .25rem; }
.theme button {
  min-height: 44px; padding: .5rem .9rem;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius);
  font: inherit; font-size: .875rem; cursor: pointer;
}
.theme button[aria-pressed="true"] { border-color: var(--focus); font-weight: 600; }

.search { margin-top: 1.25rem; }
.search label { display: block; font-weight: 600; margin-bottom: .35rem; font-size: .9rem; }
.search input {
  width: 100%; min-height: 44px; padding: .6rem .8rem;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius); font: inherit;
}

.board { max-width: 64rem; margin: 1rem auto 0; display: grid; gap: .75rem; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-left: 4px solid var(--unknown);
  border-radius: var(--radius); padding: 1rem;
}
.card--ok { border-left-color: var(--ok); }
.card--minor { border-left-color: var(--minor); }
.card--major { border-left-color: var(--major); }
.card--critical { border-left-color: var(--critical); }
.card--maintenance { border-left-color: var(--maintenance); }
.card--unknown { border-left-color: var(--unknown); }

.card__head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.card__name { font-size: 1.05rem; margin: 0; flex: 1 1 auto; }
.dot { font-size: 1rem; line-height: 1; }
.dot--ok { color: var(--ok); } .dot--minor { color: var(--minor); }
.dot--major { color: var(--major); } .dot--critical { color: var(--critical); }
.dot--maintenance { color: var(--maintenance); } .dot--unknown { color: var(--unknown); }

.badge { font-size: .8rem; font-weight: 600; padding: .2rem .55rem; border: 1px solid currentColor; border-radius: 999px; }
.badge--ok { color: var(--ok); } .badge--minor { color: var(--minor); }
.badge--major { color: var(--major); } .badge--critical { color: var(--critical); }
.badge--maintenance { color: var(--maintenance); } .badge--unknown { color: var(--unknown); }

.incident { font-weight: 600; margin: .6rem 0 .2rem; }
.desc { margin: .35rem 0; color: var(--text-dim); overflow-wrap: anywhere; }
.allclear { margin: .35rem 0 0; color: var(--text-dim); font-size: .875rem; }
.warn { margin: .5rem 0 0; color: var(--minor); font-size: .8rem; }

.children { list-style: none; margin: .6rem 0 0; padding: 0; display: grid; gap: .35rem; }
.child { display: flex; align-items: center; gap: .5rem; padding: .4rem .6rem;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px; font-size: .9rem; }
.child__name { flex: 1 1 auto; overflow-wrap: anywhere; }
.child__state { color: var(--text-dim); font-size: .8rem; white-space: nowrap; }

.foot { max-width: 64rem; margin: 2rem auto 0; color: var(--text-dim); font-size: .85rem; }
.empty { color: var(--text-dim); }

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;
