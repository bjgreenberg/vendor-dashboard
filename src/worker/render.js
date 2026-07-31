/**
 * Dashboard rendering.
 *
 * SECURITY — audit finding M4. Every field rendered here is third-party content
 * from ~34 vendor status pages: incident titles, descriptions, component names,
 * and now `sourceUrl` too. A compromised or merely sloppy vendor page is
 * untrusted input, and this is the boundary where it enters a public site.
 *
 *   - EVERY interpolated value goes through `esc()`. No exceptions.
 *   - Vendor-supplied URLs additionally go through `safeUrl()`, which permits
 *     only http/https. A `javascript:` URL in an href would be stored XSS.
 *   - No vendor HTML is ever rendered; markup arrives as text and stays text.
 *   - A per-response nonce gates the one inline script.
 *
 * SITE INTEGRATION — served at briangreenberg.net/service-status, this page
 * reuses the site's own stylesheet and theme script over same-origin paths. That
 * gives identical typography and colour, and a SHARED appearance preference
 * (the site's `bgnet-theme` localStorage key) rather than a second theme
 * implementation drifting alongside the first.
 *
 * NOTE: the header/footer markup is duplicated from the site rather than fetched
 * at runtime — runtime fetching would cost a subrequest and fail badly. The
 * trade-off is drift: if the site's chrome changes, update it here too.
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
 * Validate a vendor-supplied URL before putting it in an `href`.
 *
 * Vendors supply this (`page.url` in most payloads), so it is untrusted input.
 * Only http and https are permitted — `javascript:`, `data:` and `vbscript:` in
 * an href are all script-execution vectors, and this value is *stored* in D1 and
 * replayed to every visitor. Anything else yields '' and the caller renders
 * plain text instead of a link.
 *
 * @param {unknown} url
 * @returns {string} a safe absolute URL, or '' if not usable
 */
export function safeUrl(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Chicago-time fallback, rendered server-side so the timestamp means something
 * without JavaScript. The client upgrades it to the viewer's own timezone.
 * @param {string} iso
 * @returns {string}
 */
export function formatChicago(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return iso;
  }
}

/**
 * Translate an internal warning into something a reader can act on — or hide it.
 *
 * Warnings serve two audiences. "fetch returned HTTP 404" tells an operator
 * exactly what happened and tells a visitor nothing; "configured component X
 * matched nothing" is pure maintenance signal. The raw strings stay in
 * /api/status and in the logs, where operators actually look.
 *
 * Returns null for operator-only warnings, which are then not rendered.
 *
 * @param {string} warning
 * @returns {string|null}
 */
export function humanizeWarning(warning) {
  const w = String(warning ?? '');

  // Operator-only: config drift and maintenance signals.
  if (/matched no (component|group)/i.test(w)) return null;
  if (/catalog may be out of date/i.test(w)) return null;
  if (/scope could not be applied/i.test(w)) return null;

  // Reachability, in plain language.
  if (/fetch returned HTTP (\d+)/i.test(w)) {
    const code = w.match(/HTTP (\d+)/i)[1];
    return code.startsWith('5')
      ? "The vendor's status service is having trouble, so its status could not be read."
      : "The vendor's status service did not return a status when asked.";
  }
  if (/fetch failed|timed out|abort/i.test(w)) {
    return "The vendor's status service could not be reached.";
  }
  if (/not valid JSON|structure may have changed|not found|no adapter/i.test(w)) {
    return "The vendor changed how it publishes status, so it could not be read.";
  }

  // Anything already written for readers passes through — e.g. the Microsoft
  // consumer-services note.
  return w;
}

/**
 * @param {{records: any[], meta: any, nonce?: string, now?: () => Date, host?: string}} input
 * @returns {string} complete HTML document
 */
export function renderDashboard({
  records = [],
  meta = null,
  nonce = '',
  now = () => new Date(),
  host = CANONICAL_HOST,
}) {
  // Only the canonical host may be indexed; the workers.dev address is a
  // backend URL and indexing it would create a competing duplicate.
  const indexable = host === CANONICAL_HOST;

  const impacted = records.filter(
    (r) => r.severity !== 'operational' && r.severity !== 'unknown',
  ).length;
  const unknown = records.filter((r) => r.severity === 'unknown').length;

  // An EMPTY board is not a healthy board. Zero records means nothing was
  // checked; rendering that as "All systems operational" is the false-green
  // failure this rewrite exists to eliminate.
  const empty = records.length === 0;

  // Staleness is the dead-man's switch for our OWN collector: if the cron stops
  // firing, the last snapshot would otherwise keep rendering as current.
  const STALE_AFTER_MS = 2 * 15 * 60 * 1000;
  const checkedAtMs = meta?.checked_at ? Date.parse(meta.checked_at) : NaN;
  const stale = !Number.isNaN(checkedAtMs) && now().getTime() - checkedAtMs > STALE_AFTER_MS;

  const headline = empty
    ? 'No status data — awaiting first collection'
    : impacted > 0
      ? `${impacted} service${impacted === 1 ? '' : 's'} impacted`
      : unknown > 0
        ? `All monitored services operational (${unknown} unchecked)`
        : 'All systems operational';

  const headlineTone = empty ? 'headline--unknown' : impacted > 0 ? 'headline--impacted' : '';

  const staleBanner = stale
    ? `<p class="vs-stale" role="status">This data may be stale — the last successful collection was more than two update intervals ago.</p>`
    : '';

  const checkedBlock = meta?.checked_at
    ? `<p class="vs-meta">Last checked <time id="vs-checked" datetime="${esc(meta.checked_at)}">${esc(formatChicago(meta.checked_at))}</time>. Updates every 15 minutes.</p>`
    : `<p class="vs-meta">No collection has run yet. Updates every 15 minutes.</p>`;

  const rows = records.map((r) => renderRow(r)).join('\n');

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service Status — live status for ${esc(records.length)} cloud services</title>
<meta name="description" content="Live operational status for ${esc(records.length)} cloud and SaaS services, refreshed every 15 minutes from each vendor's own public status endpoint.">
<meta name="robots" content="${indexable ? 'index, follow' : 'noindex, nofollow'}">
<link rel="canonical" href="https://briangreenberg.net/service-status">
<link rel="icon" href="/assets/img/favicon.png" type="image/png">
<link rel="stylesheet" href="/assets/site.css">
<script${nonce ? ` nonce="${esc(nonce)}"` : ''}>
/* This page defaults to DARK, unlike the rest of the site which follows the
   system. It runs BEFORE theme.js and before first paint, so there is no flash.

   It seeds the attribute only — it deliberately does NOT write to localStorage,
   because that key (bgnet-theme) is shared with briangreenberg.net and writing
   it would silently change the whole site's default. A visitor who has actually
   chosen a theme keeps it; theme.js applies their choice a moment later. */
(function () {
  try {
    if (!localStorage.getItem('bgnet-theme')) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
</script>
<script src="/assets/js/theme.js"></script>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#vs-board">Skip to status board</a>

<header class="site">
  <div class="wrap site-inner">
    <a class="wordmark" href="/">Brian&nbsp;Greenberg</a>
    <nav class="main" aria-label="Site">
      <a href="/">Home</a>
      <a href="/about/">About</a>
      <a href="/writing/">Writing</a>
      <a href="/media/">Speaking&nbsp;&amp;&nbsp;Media</a>
      <a href="/resources/">Resources</a>
      <a href="/credentials/">Credentials</a>
      <a href="/contact/">Contact</a>
    </nav>
  </div>
</header>

<main class="wrap vs">
  <h1>Service Status</h1>

  <div class="vs-intro">
    <p>Most of the software I depend on is somebody else&rsquo;s to keep running.
    When something stops working, the first question is always whether it&rsquo;s
    me or them.</p>
    <p>This page asks ${esc(records.length)} services directly, every 15 minutes,
    and reports what each one says about itself. Nothing here is inferred, and
    nothing comes from a third-party aggregator &mdash; each status is read from
    that vendor&rsquo;s own status page, which you can open from any row.</p>
    <p>If a check fails, the service is marked <strong>Unknown</strong> rather
    than green. A check that didn&rsquo;t happen isn&rsquo;t good news.</p>
  </div>

  <p class="vs-headline ${headlineTone}">${esc(headline)}</p>
  ${staleBanner}
  ${checkedBlock}

  <div class="vs-search">
    <label for="vs-q">Filter services</label>
    <input id="vs-q" type="search" autocomplete="off" placeholder="Type to filter&hellip;"
           aria-describedby="vs-qhelp" aria-controls="vs-board">
    <p id="vs-qhelp" class="vs-hint">Matches vendor and component names.</p>
    <p id="vs-qstatus" class="vs-hint" role="status" aria-live="polite"></p>
  </div>

  <div id="vs-board" class="vs-board">
${rows || '<p class="vs-empty">No status has been collected yet. The collector runs every 15 minutes; if this persists, the scheduled job is not running.</p>'}
  </div>

  <p class="vs-note">Select a service name to open its own status page, or expand a
  card to see every component. Some vendors publish only an overall state or a
  list of current incidents, so those rows have nothing further to expand.</p>
</main>

<footer class="site">
  <div class="wrap foot-inner">
    <span>© 2008–2026 Brian Greenberg · Chicago</span>
    <span><a href="/feed/index.xml">RSS</a> · <a href="/llms.txt">llms.txt</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="https://linkedin.com/in/bjgreenberg" rel="noopener" target="_blank">LinkedIn</a> · <a href="https://github.com/bjgreenberg" rel="noopener" target="_blank">GitHub</a> · <a href="https://bsky.app/profile/briangreenberg.net" rel="noopener" target="_blank">Bluesky</a> · <a href="https://infosec.exchange/@brian_greenberg" rel="noopener" target="_blank">Mastodon</a> · <a href="https://substack.com/@briangreenberg" rel="noopener" target="_blank">Substack</a></span>
    <span class="theme-control" role="group" aria-label="Appearance">
      <span class="theme-menu">
        <button class="theme-btn" type="button" data-mode="system" title="Follow system appearance">◐<span class="sr-only">System</span></button>
        <button class="theme-btn" type="button" data-mode="light" title="Light appearance">☀&#xFE0E;<span class="sr-only">Light</span></button>
        <button class="theme-btn" type="button" data-mode="dark" title="Dark appearance">☾<span class="sr-only">Dark</span></button>
      </span>
    </span>
  </div>
</footer>

<script${nonce ? ` nonce="${esc(nonce)}"` : ''}>
(function () {
  // theme.js re-applies 'system' when no preference is stored, which would undo
  // the dark seed above. Re-assert it — again without persisting, so the site's
  // own default is untouched.
  try {
    if (!localStorage.getItem('bgnet-theme')) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) { /* storage unavailable; the seed above already applied */ }

  // Timestamp: show the VIEWER's own timezone plus a relative age, keeping the
  // server-rendered Chicago time in the title. Progressive enhancement — the
  // Chicago time is already meaningful without this running.
  var el = document.getElementById('vs-checked');
  if (el) {
    var d = new Date(el.getAttribute('datetime'));
    if (!isNaN(d.getTime())) {
      var chicago = el.textContent;
      var local = new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
      }).format(d);
      var mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
      var hrs = Math.round(mins / 60);
      var ago = mins < 1 ? 'just now'
        : mins === 1 ? '1 minute ago'
        : mins < 60 ? mins + ' minutes ago'
        : hrs === 1 ? '1 hour ago'
        : hrs + ' hours ago';
      el.textContent = local + ' (' + ago + ')';
      el.title = 'Chicago time: ' + chicago;
    }
  }

  // Client-side filter over an already-rendered list. Also searches component
  // names, so typing "gmail" finds Google.
  var q = document.getElementById('vs-q');
  var status = document.getElementById('vs-qstatus');
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
 * One vendor card.
 *
 * Collapsed by default: the parent row plus any AFFECTED components. A
 * `<details>` discloses the full component list on demand — a native element,
 * so it is keyboard-accessible and works with JavaScript disabled.
 *
 * @param {any} record
 */
function renderRow(record) {
  const p = PRESENTATION[record.severity] ?? PRESENTATION.unknown;
  const all = Array.isArray(record.components) ? record.components : [];
  const affected = all.filter((c) => c.severity !== 'operational');

  // Searching covers component names too, so "gmail" finds Google.
  const haystack = [record.vendor, record.service, ...all.map((c) => c.name)]
    .join(' ')
    .toLowerCase();

  const href = safeUrl(record.sourceUrl);
  const name = esc(record.service || record.vendor);
  const nameHtml = href
    ? `<a class="vs-name" href="${esc(href)}" rel="noopener nofollow" target="_blank">${name}<span class="vs-ext" aria-hidden="true">↗</span><span class="sr-only"> — opens ${esc(hostOf(href))} in a new tab</span></a>`
    : `<span class="vs-name">${name}</span>`;

  const affectedList = affected.length
    ? `<ul class="vs-children">${affected.map(childLi).join('')}</ul>`
    : '';

  const allList = all.length
    ? `<details class="vs-all">
    <summary>${esc(all.length)} component${all.length === 1 ? '' : 's'}${
      affected.length ? ` · ${esc(affected.length)} affected` : ' · all healthy'
    }</summary>
    <ul class="vs-children">${all.map(childLi).join('')}</ul>
  </details>`
    : '';

  // Reader-facing warnings only; the raw text remains in /api/status.
  const readerWarnings = (record.warnings ?? [])
    .map(humanizeWarning)
    .filter(Boolean);
  const warning = readerWarnings.length ? `<p class="vs-warn">${esc(readerWarnings[0])}</p>` : '';

  return `<article class="vs-card vs-card--${esc(p.tone)}" data-search="${esc(haystack)}">
  <div class="vs-head">
    <span class="vs-dot vs-dot--${esc(p.tone)}" aria-hidden="true">${esc(p.symbol)}</span>
    <h2>${nameHtml}</h2>
    <span class="vs-badge vs-badge--${esc(p.tone)}">${esc(p.label)}</span>
  </div>
  ${record.incidentName ? `<p class="vs-incident">${esc(record.incidentName)}</p>` : ''}
  <p class="vs-desc">${esc(record.description)}</p>
  ${affectedList}
  ${allList}
  ${warning}
</article>`;
}

/** @param {string} url already validated by safeUrl */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the vendor status page';
  }
}

/** @param {{name: string, severity: string}} c */
function childLi(c) {
  const cp = PRESENTATION[c.severity] ?? PRESENTATION.unknown;
  return `<li class="vs-child">
    <span class="vs-dot vs-dot--${esc(cp.tone)}" aria-hidden="true">${esc(cp.symbol)}</span>
    <span class="vs-child-name">${esc(c.name)}</span>
    <span class="vs-child-state">${esc(cp.label)}</span>
  </li>`;
}

/**
 * Page-specific styles only.
 *
 * Typography, layout, colour and the theme system come from the site's own
 * `/assets/site.css`. These rules add status semantics on top, deriving
 * neutrals from `currentColor` so they follow the site in light and dark
 * without duplicating its palette.
 */
const STYLES = `
.vs h1 { margin-bottom: .5rem; }
.vs-intro { max-width: 62ch; margin: 0 0 1.5rem; }
.vs-intro p { margin: 0 0 .6rem; }
.vs-intro p:last-child { margin-bottom: 0; }
.vs-headline { font-size: 1.15rem; font-weight: 600; margin: .25rem 0 .5rem; color: #1f7a3d; }
.vs-headline.headline--impacted { color: #b3261e; }
.vs-headline.headline--unknown { color: #6b7280; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .vs-headline { color: #52c47a; }
  :root:not([data-theme="light"]) .vs-headline.headline--impacted { color: #ff6b61; }
}
:root[data-theme="dark"] .vs-headline { color: #52c47a; }
:root[data-theme="dark"] .vs-headline.headline--impacted { color: #ff6b61; }

.vs-meta, .vs-hint, .vs-note { font-size: .875rem; opacity: .75; margin: .25rem 0; }
.vs-stale {
  margin: .5rem 0; padding: .6rem .8rem; font-size: .875rem;
  border: 1px solid currentColor; border-radius: 8px; color: #8a5a00;
}

.vs-search { margin: 1.25rem 0 1rem; }
.vs-search label { display: block; font-weight: 600; font-size: .9rem; margin-bottom: .35rem; }
.vs-search input {
  width: 100%; min-height: 44px; padding: .6rem .8rem; font: inherit;
  color: inherit; background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
  border-radius: 8px;
}

.vs-board { display: grid; gap: .75rem; }
.vs-card {
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-left: 4px solid #6b7280;
  border-radius: 10px; padding: 1rem;
  background: color-mix(in srgb, currentColor 4%, transparent);
}
.vs-card--ok { border-left-color: #1f7a3d; }
.vs-card--minor { border-left-color: #8a5a00; }
.vs-card--major { border-left-color: #b3480f; }
.vs-card--critical { border-left-color: #b3261e; }
.vs-card--maintenance { border-left-color: #2c5aa0; }
.vs-card--unknown { border-left-color: #6b7280; }

.vs-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.vs-head h2 { font-size: 1.05rem; margin: 0; flex: 1 1 auto; }
.vs-ext { font-size: .75em; opacity: .6; margin-left: .25em; }

.vs-dot { line-height: 1; }
.vs-dot--ok { color: #1f7a3d; } .vs-dot--minor { color: #8a5a00; }
.vs-dot--major { color: #b3480f; } .vs-dot--critical { color: #b3261e; }
.vs-dot--maintenance { color: #2c5aa0; } .vs-dot--unknown { color: #6b7280; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .vs-dot--ok { color: #52c47a; }
  :root:not([data-theme="light"]) .vs-dot--critical { color: #ff6b61; }
  :root:not([data-theme="light"]) .vs-dot--major { color: #f08a4b; }
  :root:not([data-theme="light"]) .vs-dot--minor { color: #e0a53a; }
}

.vs-badge {
  font-size: .78rem; font-weight: 600; padding: .2rem .55rem;
  border: 1px solid currentColor; border-radius: 999px; white-space: nowrap;
}
.vs-badge--ok { color: #1f7a3d; } .vs-badge--minor { color: #8a5a00; }
.vs-badge--major { color: #b3480f; } .vs-badge--critical { color: #b3261e; }
.vs-badge--maintenance { color: #2c5aa0; } .vs-badge--unknown { color: #6b7280; }

.vs-incident { font-weight: 600; margin: .6rem 0 .2rem; }
.vs-desc { margin: .35rem 0; opacity: .8; overflow-wrap: anywhere; }
.vs-warn { margin: .5rem 0 0; font-size: .8rem; color: #8a5a00; }

.vs-children { list-style: none; margin: .6rem 0 0; padding: 0; display: grid; gap: .3rem; }
.vs-child {
  display: flex; align-items: center; gap: .5rem;
  padding: .35rem .6rem; font-size: .9rem;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 8px;
}
.vs-child-name { flex: 1 1 auto; overflow-wrap: anywhere; }
.vs-child-state { font-size: .78rem; opacity: .7; white-space: nowrap; }

.vs-all { margin-top: .6rem; }
.vs-all > summary {
  cursor: pointer; font-size: .85rem; opacity: .75; padding: .4rem 0; min-height: 30px;
}
.vs-all > summary:hover { opacity: 1; }

.vs-empty { opacity: .75; }
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 1rem; top: 1rem; z-index: 10; padding: .75rem 1rem; }

@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
