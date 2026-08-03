# Privacy — vendor-dashboard

Last updated: 2026-08-02 10:00 PM CDT

This covers both the **code in this repository** and the **live dashboard** it
serves at <https://briangreenberg.net/service-status>.

## What the dashboard collects from visitors: nothing

- **No cookies, no analytics, no tracking** in this Worker. The page sets no
  identifiers and phones nothing home.
- **localStorage** is used only for explicit visitor preferences, stored on
  the visitor's own device and never transmitted: the site-wide appearance
  choice (`bgnet-theme`, written only when a visitor picks a theme) and, if a
  visitor uses the Mastodon share button, their chosen instance hostname
  (`bgnet-mastodon-instance`).
- **Vendor logos are self-hosted deliberately.** Hot-linking icons would leak
  every visitor's IP address to ~46 third-party companies on every page view;
  serving them from this Worker means a page view contacts no one but the
  page itself.
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
