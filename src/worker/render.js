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

import LOGOS from '../../config/logos.json';

const SHARE_URL = 'https://briangreenberg.net/service-status';
const SHARE_TITLE = 'Service Status';

/**
 * ANALYTICS — the same two systems the rest of briangreenberg.net uses, with
 * the same rules, so this page reports alongside the site instead of being a
 * blind spot in it.
 *
 * Both identifiers are PUBLIC by design (they render into every page of the
 * site already, and are committed in that repo's _data/analytics.js). They are
 * not credentials and there is nothing to leak here.
 *
 *   Cloudflare Web Analytics — UNGATED. Cookieless, stores nothing on the
 *     device, no fingerprinting, so it sits outside consent requirements.
 *     The site makes the same call and states it on /privacy/.
 *
 *   Google Analytics 4 — CONSENT-GATED, and deliberately not loaded here.
 *     This page emits only the id, on <html data-ga4-id>, and loads the
 *     site's own /assets/js/consent.js. That module shows the banner, honours
 *     `analytics-consent` in localStorage, and injects the Google tag ONLY
 *     after consent is granted. Same origin as the site, so a visitor who
 *     already decided there is not asked again here.
 *
 * Never add a googletagmanager <script src> to this markup: it would load
 * Google before consent and quietly break that guarantee (a test pins it).
 */
const GA4_ID = 'G-6XYP02XLFE';
const CF_BEACON_TOKEN = '525f27dcb953478db9d0e947f477281a';

/** Where self-hosted vendor marks are served from (Workers static assets). */
const ICON_BASE = '/service-status/icons';

/**
 * Slug used for both the logo filename and lookup.
 * @param {string} name
 */
export function logoSlug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

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
    ? `<p class="vs-meta">Last collection <time id="vs-checked" datetime="${esc(meta.checked_at)}">${esc(formatChicago(meta.checked_at))}</time>. Each service is re-checked every 15 minutes.</p>`
    : `<p class="vs-meta">No collection has run yet. Each service is re-checked every 15 minutes.</p>`;

  // Social description reflects the LIVE board, so a share during an incident
  // says so instead of claiming everything is fine.
  const ogDescription = empty
    ? 'Live status for cloud and SaaS services, read from each vendor\u2019s own status page.'
    : `${records.length} cloud and SaaS services, each re-checked every 15 minutes. ${
        impacted > 0 ? `${impacted} currently impacted.` : 'All operational.'
      } Read from each vendor\u2019s own status page.`;

  const rows = records.map((r) => renderRow(r)).join('\n');

  return `<!doctype html>
<html lang="en" data-theme="dark" data-ga4-id="${esc(GA4_ID)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service Status — live status for ${esc(records.length)} cloud services</title>
<meta name="description" content="Live operational status for ${esc(records.length)} cloud and SaaS services, each re-checked every 15 minutes from that vendor's own public status endpoint.">
<meta name="robots" content="${indexable ? 'index, follow' : 'noindex, nofollow'}">
<link rel="canonical" href="https://briangreenberg.net/service-status">

<!-- Social / GEO. The site's own pages get these from Eleventy; this page is a
     separate Worker, so they are emitted here. Absolute URLs are required:
     scrapers do not resolve relative og:image. -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Brian Greenberg">
<meta property="og:url" content="https://briangreenberg.net/service-status">
<meta property="og:title" content="Service Status">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:image" content="https://briangreenberg.net/service-status/card.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Service Status — live status for cloud and SaaS services, from briangreenberg.net">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Service Status">
<meta name="twitter:description" content="${esc(ogDescription)}">
<meta name="twitter:image" content="https://briangreenberg.net/service-status/card.jpg">
<meta name="twitter:image:alt" content="Service Status — live status for cloud and SaaS services, from briangreenberg.net">
<link rel="icon" href="/assets/img/favicon.png" type="image/png">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
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
<!-- Analytics, mirroring the site exactly (see ANALYTICS above).
     Cloudflare Web Analytics is cookieless and ungated; Google Analytics is
     loaded ONLY by the site's own consent gate, never from here. -->
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${esc(CF_BEACON_TOKEN)}"}'></script>
<script src="/assets/js/consent.js" defer></script>
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
    <p>This page asks ${esc(records.length)} services directly, re-checking each one
    every 15 minutes,
    and reports what each one says about itself. Nothing here is inferred, and
    nothing comes from a third-party aggregator &mdash; each status is read from
    that vendor&rsquo;s own status page, which you can open from any row.</p>
    <p>If a check fails, the service is marked <strong>Unknown</strong> rather
    than green. A check that didn&rsquo;t happen isn&rsquo;t good news.</p>
    <p>This board watches from a <strong>US vantage point</strong>: where a
    vendor publishes per-region status, a row&rsquo;s state reflects its US
    regions. Trouble elsewhere in the world still appears as a note on that
    provider&rsquo;s card &mdash; it informs, but it doesn&rsquo;t change the
    row&rsquo;s color.</p>
  </div>

  <!-- Share bar: plain intent links only, zero third-party JS or SDKs, matching
       the site's privacy posture (src/_includes/share.njk). Keep the platform
       list in sync with that include - the two drifted once already.

       Mastodon is a BUTTON, not a link: the fediverse has no universal share
       endpoint, so the sharer's own instance has to be asked for (and
       remembered) before a /share URL can be built. Still no third-party JS.

       Instagram, TikTok and Apple Music are deliberately absent - none of them
       exposes a web share intent at all, so there is no honest link to write.
       The native Share button reaches them via the OS share sheet; Copy link
       covers everything else. -->

  <div class="share-bar vs-share" data-url="${esc(SHARE_URL)}" data-title="${esc(SHARE_TITLE)}">
    <span class="share-label">Share</span>
    <a class="pill" rel="noopener" target="_blank" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_URL)}"><img class="pillfav" alt="" width="16" height="16" src="/assets/icons/social/linkedin.com.png">LinkedIn</a>
    <a class="pill" rel="noopener" target="_blank" href="https://bsky.app/intent/compose?text=${encodeURIComponent(SHARE_TITLE + ' ' + SHARE_URL)}"><img class="pillfav" alt="" width="16" height="16" src="/assets/icons/social/bsky.app.png">Bluesky</a>
    <a class="pill" rel="noopener" target="_blank" href="https://x.com/intent/tweet?url=${encodeURIComponent(SHARE_URL)}&amp;text=${encodeURIComponent(SHARE_TITLE)}"><img class="pillfav" alt="" width="16" height="16" src="/assets/icons/social/x.com.png">X</a>
    <a class="pill" rel="noopener" target="_blank" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}"><img class="pillfav" alt="" width="16" height="16" src="/assets/icons/social/facebook.com.png">Facebook</a>
    <a class="pill" rel="noopener" target="_blank" href="https://www.threads.net/intent/post?text=${encodeURIComponent(SHARE_TITLE + ' ' + SHARE_URL)}"><img class="pillfav" alt="" width="16" height="16" src="/assets/icons/social/threads.com.png">Threads</a>
    <button class="pill share-mastodon" type="button"><img class="pillfav" alt="" width="16" height="16" src="/assets/icons/social/infosec.exchange.png">Mastodon</button>
    <a class="pill" href="mailto:?subject=${encodeURIComponent(SHARE_TITLE)}&amp;body=${encodeURIComponent(SHARE_URL)}">&#9993; Email</a>
    <button class="pill share-copy" type="button">&#128279; Copy link</button>
    <button class="pill share-native" type="button" hidden>&#8599; Share&hellip;</button>
  </div>

  <p class="vs-headline ${headlineTone}">${esc(headline)}</p>
  ${staleBanner}
  ${checkedBlock}

  <p class="vs-note">Select a service name to open its own status page, or expand a
  card to see every component. Some vendors publish only an overall state or a
  list of current incidents, so those rows have nothing further to expand.</p>

  <div class="vs-search">
    <label for="vs-q">Filter services</label>
    <input id="vs-q" type="search" autocomplete="off" placeholder="Type to filter&hellip;"
           aria-describedby="vs-qhelp" aria-controls="vs-board">
    <p id="vs-qhelp" class="vs-hint">Matches vendor and component names.</p>
    <p id="vs-qstatus" class="vs-hint" role="status" aria-live="polite"></p>
  </div>

  <div id="vs-board" class="vs-board">
${rows || '<p class="vs-empty">No status has been collected yet. The collector runs continuously; if this persists, the scheduled job is not running.</p>'}
  </div>

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
  // Chicago time is already meaningful without this running. renderAge re-runs
  // on a minute interval so the page never claims to be fresher than it is;
  // the interval only rewrites this one text node, it never reloads.
  var el = document.getElementById('vs-checked');
  if (el) {
    var d = new Date(el.getAttribute('datetime'));
    if (!isNaN(d.getTime())) {
      var chicago = el.textContent;
      var local = new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
      }).format(d);
      var renderAge = function () {
        var mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
        var hrs = Math.round(mins / 60);
        var ago = mins < 1 ? 'just now'
          : mins === 1 ? '1 minute ago'
          : mins < 60 ? mins + ' minutes ago'
          : hrs === 1 ? '1 hour ago'
          : hrs + ' hours ago';
        el.textContent = local + ' (' + ago + ')';
        el.title = 'Chicago time: ' + chicago;
      };
      renderAge();
      setInterval(function () { renderAge(); }, 60000);
    }
  }

  // Tab-return refresh. The board changes every minute (one shard per cron
  // tick), but a timed reload would wipe the filter and expanded components
  // mid-reading — a WCAG 2.2.1 problem and plain rude. So: NO reload while
  // visible, ever. Returning to a tab hidden for 5+ minutes reloads it, so
  // the board is never stale when someone actually looks at it. The filter
  // text survives via sessionStorage (restored below).
  var RELOAD_AFTER_HIDDEN_MS = 5 * 60 * 1000;
  var hiddenAt = null;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null && Date.now() - hiddenAt >= RELOAD_AFTER_HIDDEN_MS) {
      location.reload();
    } else {
      hiddenAt = null;
    }
  });

  // Share bar: copy-link and the native share sheet. No SDKs - the platform
  // links above are plain intents.
  var bar = document.querySelector('.share-bar');
  if (bar) {
    var url = bar.getAttribute('data-url');
    var copy = bar.querySelector('.share-copy');
    if (copy && navigator.clipboard) {
      copy.addEventListener('click', function () {
        navigator.clipboard.writeText(url).then(function () {
          var old = copy.textContent;
          copy.textContent = '\u2713 Copied';
          setTimeout(function () { copy.textContent = old; }, 1600);
        });
      });
    }
    // Mastodon: no universal endpoint, so ask once for the instance and
    // remember it. Strip scheme and path so a pasted profile URL still works.
    var masto = bar.querySelector('.share-mastodon');
    if (masto) {
      masto.addEventListener('click', function () {
        var KEY = 'bgnet-mastodon-instance';
        var saved = '';
        try { saved = localStorage.getItem(KEY) || ''; } catch (e) {}
        var host = window.prompt('Your Mastodon instance (e.g. infosec.exchange)', saved || 'infosec.exchange');
        if (!host) return;
        host = host.trim().replace(/^https?:\\/\\//, '').replace(/\\/.*$/, '');
        if (!/^[a-z0-9.-]+\\.[a-z]{2,}$/i.test(host)) return;
        try { localStorage.setItem(KEY, host); } catch (e) {}
        window.open('https://' + host + '/share?text=' +
          encodeURIComponent(bar.getAttribute('data-title') + ' ' + url), '_blank', 'noopener');
      });
    }

    var native = bar.querySelector('.share-native');
    if (native && navigator.share) {
      native.hidden = false;
      native.addEventListener('click', function () {
        navigator.share({ title: bar.getAttribute('data-title'), url: url }).catch(function () {});
      });
    }
  }

  // Client-side filter over an already-rendered list. Also searches component
  // names, so typing "gmail" finds Google. The value is mirrored into
  // sessionStorage so the tab-return reload above cannot eat a typed query —
  // sessionStorage deliberately, not localStorage: a filter is a this-visit
  // thought, not a preference.
  var q = document.getElementById('vs-q');
  var status = document.getElementById('vs-qstatus');
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-search]'));
  if (q) {
    var applyFilter = function () {
      var term = q.value.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (card) {
        var hit = !term || card.getAttribute('data-search').indexOf(term) !== -1;
        card.hidden = !hit;
        if (hit) shown++;

        // Reported 2026-08-03: "google" returned Calendly, Oracle and Seismic
        // alongside Google, with nothing saying why. Every one was a real
        // component match (Calendly publishes "Google Analytics", Oracle
        // "Oracle Database@Google Cloud"), and matching component names is
        // what lets "gmail" find Google — so the fix is to EXPLAIN the match,
        // not to narrow it: the vendor whose own name matches sorts first,
        // and a card matched only on its components says which ones.
        var why = card.querySelector('.vs-why');
        if (why) why.remove();
        card.style.order = '';
        if (!term || !hit) return;

        var nameMatch = (card.getAttribute('data-vendor') || '').indexOf(term) !== -1;
        card.style.order = nameMatch ? '-1' : '0';
        if (nameMatch) return;

        var matched = [];
        card.querySelectorAll('.vs-child-name').forEach(function (el) {
          var n = (el.textContent || '').trim();
          if (n && n.toLowerCase().indexOf(term) !== -1 && matched.indexOf(n) === -1) matched.push(n);
        });
        if (!matched.length) return;

        var p = document.createElement('p');
        p.className = 'vs-why';
        p.textContent = 'Matches: ' + matched.slice(0, 3).join(', ') +
          (matched.length > 3 ? ' (+' + (matched.length - 3) + ' more)' : '');
        card.appendChild(p);
      });
      status.textContent = term
        ? shown + (shown === 1 ? ' service matches' : ' services match')
        : '';
    };
    q.addEventListener('input', function () {
      try { sessionStorage.setItem('vs-filter', q.value); } catch (e) {}
      applyFilter();
    });
    try {
      var saved = sessionStorage.getItem('vs-filter');
      if (saved) { q.value = saved; applyFilter(); }
    } catch (e) { /* storage unavailable; filter still works, just unsaved */ }
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

  // Emit a mark only when one actually exists. Three vendors bot-block the
  // build-time fetch (NetSuite, OpenAI, Tableau), so absence is normal and must
  // degrade to the status dot rather than a broken image.
  const file = LOGOS[logoSlug(record.vendor)];
  // The mark is the row's IDENTITY ANCHOR, sitting where the eye starts rather
  // than after the name it identifies. It replaces the status dot, which was
  // redundant: status is already carried twice, by the card's coloured left
  // border and by the pill text. Vendors with no mark keep the dot, so a row
  // never loses its leading glyph.
  const logo = file
    ? `<img class="vs-logo" src="${esc(ICON_BASE)}/${esc(file)}" alt="" width="24" height="24" loading="lazy" decoding="async">`
    : '';
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

  // A stable id per row. The genuine want behind "share each service" is
  // "look at THIS row", which a deep link satisfies - 41 share widgets would be
  // clutter, and nobody shares a vendor's status from an aggregator anyway when
  // the row already links the vendor's own page.
  const anchor = logoSlug(record.vendor);

  // data-vendor is the vendor's own NAME text, kept apart from the combined
  // haystack so the filter can distinguish "you searched for this vendor"
  // from "this vendor merely mentions your term". Component names are NOT
  // duplicated into an attribute: they already exist in the card's disclosure
  // list, so the filter reads them from there. One source of truth, and
  // healthy component names stay out of the always-visible markup, which is
  // a presentation contract two tests pin.
  return `<article id="${esc(anchor)}" class="vs-card vs-card--${esc(p.tone)}" data-search="${esc(haystack)}" data-vendor="${esc(
    `${record.vendor} ${record.service ?? ''}`.toLowerCase(),
  )}">
  <div class="vs-head">
    ${logo || `<span class="vs-dot vs-dot--${esc(p.tone)}" aria-hidden="true">${esc(p.symbol)}</span>`}
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

  // Per-component DETAIL. Adapters have been filling this in for a while --
  // AWS's event-log excerpt naming the affected regions and what happened,
  // Oracle's and Azure DevOps' affected regions, IBM's incident title -- and
  // the renderer dropped it on the floor, so a reader saw "Multiple services /
  // Degraded" and nothing about the actual failure. Reported 2026-08-01.
  //
  // Shown only for components that are NOT operational: a healthy component's
  // description is empty by construction, and rendering the element anyway
  // would put an empty box under all 268 AWS services.
  const detail =
    c.severity !== 'operational' && c.description
      ? `<p class="vs-child-detail">${esc(c.description)}</p>`
      : '';

  return `<li class="vs-child${detail ? ' vs-child--detailed' : ''}">
    <span class="vs-dot vs-dot--${esc(cp.tone)}" aria-hidden="true">${esc(cp.symbol)}</span>
    <span class="vs-child-name">${esc(c.name)}</span>
    <span class="vs-child-state">${esc(cp.label)}</span>
    ${detail}
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
.vs-intro { margin: 0 0 1.5rem; }  /* full container width, matching the cards */
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
:root[data-theme="dark"] .vs-headline.headline--unknown { color: #a3adba; }

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
/* Vendor marks.
   Sits INSIDE the <h2>, immediately after the name: as a sibling of the heading
   it would be pushed to the far right by that heading's flex-grow, stranding it
   beside the badge instead of the name it belongs to.

   THE CHIP IS NOT DECORATION. Vendor favicons are whatever each vendor chose -
   several are dark marks on transparency (Anthropic, Okta, Docusign, Celigo,
   Lucid, Perplexity all measured below 0.28 luminance) and would be effectively
   invisible on this page, which defaults to dark. A near-white chip guarantees
   every mark reads on both themes without editing anyone's logo.

   Fixed box + object-fit: contain, on top of build-time trimming to the visible
   bounding box, is what makes 41 marks of wildly different aspect ratios and
   built-in padding look like the same size.

   Decorative: alt="" because the vendor name is right beside it. */
.vs-logo {
  width: 24px; height: 24px; object-fit: contain;
  flex: 0 0 auto;
  padding: 1px; border-radius: 5px;
  background: #ffffff;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.08);
}
/* Light theme: the chip would be near-invisible against the page, so soften it
   to a hairline and let the mark sit on the page colour. */
:root[data-theme="light"] .vs-logo { background: rgba(0,0,0,.03); }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .vs-logo { background: rgba(0,0,0,.03); }
}
.vs-ext { font-size: .75em; opacity: .6; margin-left: .25em; }

.vs-dot { line-height: 1; }
.vs-dot--ok { color: #1f7a3d; } .vs-dot--minor { color: #8a5a00; }
.vs-dot--major { color: #b3480f; } .vs-dot--critical { color: #b3261e; }
.vs-dot--maintenance { color: #2c5aa0; } .vs-dot--unknown { color: #6b7280; }
/* Dark-mode status colours.
   Measured against the site's dark background (#16191D) for WCAG 2.2 AA. The
   badge text is 0.78rem, i.e. NORMAL text, so 4.5:1 is required - the 3:1
   large-text allowance does not apply.

   The light-mode values for maintenance (#2c5aa0, 2.58:1) and unknown
   (#6b7280, 3.65:1) both FAILED here; they were missing from this block, so
   they leaked through from light mode. The unknown state is not hypothetical:
   it shows whenever a vendor check fails, and this page defaults to dark.

   NOTE: no backticks in this comment - it lives inside a JS template literal,
   and a stray backtick terminates it. That exact mistake broke the build here.

   ok 8.01  critical 6.32  major 7.09  minor 8.07  maintenance 7.23  unknown 7.76 */
:root[data-theme="dark"] .vs-dot--ok,
:root[data-theme="dark"] .vs-badge--ok { color: #52c47a; }
:root[data-theme="dark"] .vs-dot--critical,
:root[data-theme="dark"] .vs-badge--critical { color: #ff6b61; }
:root[data-theme="dark"] .vs-dot--major,
:root[data-theme="dark"] .vs-badge--major { color: #f08a4b; }
:root[data-theme="dark"] .vs-dot--minor,
:root[data-theme="dark"] .vs-badge--minor,
:root[data-theme="dark"] .vs-warn,
:root[data-theme="dark"] .vs-stale { color: #e0a53a; }
:root[data-theme="dark"] .vs-dot--maintenance,
:root[data-theme="dark"] .vs-badge--maintenance { color: #7aa7f0; }
:root[data-theme="dark"] .vs-dot--unknown,
:root[data-theme="dark"] .vs-badge--unknown { color: #a3adba; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .vs-dot--ok,
  :root:not([data-theme="light"]) .vs-badge--ok { color: #52c47a; }
  :root:not([data-theme="light"]) .vs-dot--critical,
  :root:not([data-theme="light"]) .vs-badge--critical { color: #ff6b61; }
  :root:not([data-theme="light"]) .vs-dot--major,
  :root:not([data-theme="light"]) .vs-badge--major { color: #f08a4b; }
  :root:not([data-theme="light"]) .vs-dot--minor,
  :root:not([data-theme="light"]) .vs-badge--minor,
  :root:not([data-theme="light"]) .vs-warn,
  :root:not([data-theme="light"]) .vs-stale { color: #e0a53a; }
  :root:not([data-theme="light"]) .vs-dot--maintenance,
  :root:not([data-theme="light"]) .vs-badge--maintenance { color: #7aa7f0; }
  :root:not([data-theme="light"]) .vs-dot--unknown,
  :root:not([data-theme="light"]) .vs-badge--unknown { color: #a3adba; }
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

.vs-share { margin: 0 0 1rem; }
/* The per-row permalink glyph is GONE (2026-08-03), and this comment is the
   reason it should not come back. It was reported twice as a rendering
   artifact: once from a phone, where sticky hover revealed it on tap, and
   once from a desktop, where it appeared on hover exactly as designed. An
   affordance that gets mistaken for a bug on both pointer types is not
   discoverable, it is noise sitting next to the status pill.
   Deep linking is unaffected: every card still carries a slug id, so
   /service-status#cloudflare works, and the :target rule below still
   emphasises the row on arrival. Nothing was lost except the glyph.
   NOTE: no backticks in this comment. They terminate the JS template literal
   this CSS lives in - the same trap that silently dropped 52 tests once. */
/* Deep-linked row gets a moment of emphasis so it is findable on arrival. */
.vs-card:target { box-shadow: 0 0 0 2px currentColor; }

.vs-child--detailed { flex-wrap: wrap; }
.vs-child-detail {
  flex: 1 0 100%;
  margin: .35rem 0 0;
  font-size: .85rem;
  opacity: .8;
  line-height: 1.45;
}

/* Why a card is in the filtered results, when the match came from a component
   name rather than the vendor's own name. Same muted register as .vs-warn so
   it reads as a note about the search, not as vendor status. */
.vs-why { margin: .6rem 0 0; font-size: .8rem; opacity: .75; overflow-wrap: anywhere; }

.vs-empty { opacity: .75; }
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 1rem; top: 1rem; z-index: 10; padding: .75rem 1rem; }

@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
