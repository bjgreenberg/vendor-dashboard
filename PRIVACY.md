# Privacy — vendor-dashboard

Last updated: 2026-08-04 03:49 PM CDT

This covers both the **code in this repository** and the **live dashboard** it
serves at <https://briangreenberg.net/service-status>.

## What the dashboard collects from visitors

This page is part of briangreenberg.net and uses the **same two analytics
systems as the rest of the site, under the same rules**. It runs no third
party beyond those, and no social SDKs.

- **Cloudflare Web Analytics** runs on every page view. It is **cookieless**,
  stores nothing on your device, and does not fingerprint you, which is why it
  is not gated behind consent. (The site makes the same call and says so at
  <https://briangreenberg.net/privacy/>.)
- **Google Analytics 4** is **not loaded unless you accept it.** Nothing is
  requested from Google, and no analytics cookie is set, until consent is
  granted through the banner or the controls on the site's privacy page. The
  decision is stored on your device (`analytics-consent`) and shared with the
  rest of briangreenberg.net, so choosing once covers the whole site including
  this page. Declining leaves the page fully functional.
- **localStorage** is otherwise used only for explicit preferences, stored on
  your device and never transmitted: the site-wide appearance choice
  (`bgnet-theme`), your Mastodon instance if you use that share button
  (`bgnet-mastodon-instance`), and your typed filter for the length of the
  visit (`vs-filter`, session only).
- **Vendor logos are self-hosted deliberately.** Hot-linking icons would leak
  your IP address to ~46 third-party companies on every page view; serving
  them from this Worker means a page view contacts no vendor at all.
- The share bar uses **plain intent links** — no third-party SDKs or embeds.
  Nothing loads from a social network unless you click through to it.

## What the operator sees

- The Worker emits **operational logs only** (collection counts, severities,
  durations — see `src/worker/index.js`); it does not log visitor requests,
  IPs, or user agents. Requests traverse Cloudflare's edge, which processes
  traffic per [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- The broader site's policy is at
  <https://briangreenberg.net/privacy/>; this Worker is narrower than it, not
  wider.

## What the collector sends to vendors

Every 15 minutes per vendor, an HTTP GET to that vendor's **public,
unauthenticated status endpoint**, identifying itself honestly via
`User-Agent: vendor-dashboard/2.0 (+https://briangreenberg.net/service-status; status monitor)`.
No visitor data is ever included — collection runs on a schedule, not on page
views.

## The repository

Static code and recorded public status payloads (`test/fixtures/`). No
personal data, no credentials (enforced by the `secret-scan` CI gate over the
full history).
