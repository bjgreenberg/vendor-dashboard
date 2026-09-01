#!/usr/bin/env node
/**
 * Probe a status endpoint and print a markdown diagnosis to stdout.
 *
 * The THIN half of the watchdog's diagnosis: three probes (DNS chain, TLS
 * certificate identity, HTTP with a manual redirect walk), then the pure
 * classifier (classify.mjs) turns the results into a classification and a
 * fix playbook. Node >=18 stdlib only — this runs inside the watchdog
 * GitHub Action with no npm install.
 *
 * Evidence is printed inside a fenced block: endpoint responses are
 * third-party content and are never interpolated into markdown structure.
 *
 * Usage: node scripts/watchdog/diagnose-endpoint.mjs <url>
 */
import { resolveCname, resolve4 } from 'node:dns/promises';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import { classify } from './classify.mjs';

const raw = process.argv[2];
if (!raw) {
  console.error('usage: diagnose-endpoint.mjs <url>');
  process.exit(2);
}
let url;
try {
  url = new URL(raw);
} catch {
  // A malformed URL must degrade the issue body, never abort the filing
  // (2026-09-01: an uncaught TypeError here suppressed a real rot alert).
  console.log(`_(automatic diagnosis unavailable: not a valid URL: ${raw})_`);
  process.exit(0);
}
const host = url.hostname;

async function probeDns() {
  const chain = [host];
  try {
    let cur = host;
    for (let i = 0; i < 5; i += 1) {
      const cnames = await resolveCname(cur).catch(() => []);
      if (cnames.length === 0) break;
      cur = cnames[0];
      chain.push(cur);
    }
    await resolve4(chain[chain.length - 1]);
    return { ok: true, chain };
  } catch (e) {
    return { ok: false, chain, error: String(e?.code ?? e) };
  }
}

function probeTls() {
  return new Promise((resolve) => {
    const sock = tlsConnect(
      // rejectUnauthorized: false is the point of this probe, not a shortcut
      // (CodeQL js/disabling-certificate-validation, dismissed with reason).
      // This is a DIAGNOSTIC: it inspects whatever certificate a broken
      // endpoint serves — a strict handshake would refuse exactly the
      // mismatched certs this tool exists to report (SendGrid 2026-08-12
      // served *.statuspage.io for status.sendgrid.com). No application data
      // crosses the socket: handshake, read the peer certificate, close. The
      // verification RESULT (checkServerIdentity below) is the probe's
      // output, not a trust decision.
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10_000 },
      () => {
        const cert = sock.getPeerCertificate();
        const mismatch = checkServerIdentity(host, cert);
        resolve({
          ok: true,
          matchesHost: mismatch === undefined,
          subject: cert?.subject?.CN ?? '',
        });
        sock.end();
      },
    );
    sock.on('error', (e) => resolve({ ok: false, error: String(e?.code ?? e) }));
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

/**
 * Read at most MAX_BODY_BYTES of a response.
 *
 * A rotted endpoint can serve an arbitrarily large HTML/JS page, and this
 * probe only needs a JSON-or-not signal — an unbounded res.text() is an OOM
 * waiting for the worst payload (Copilot review, PR #87). Real JSON status
 * feeds run up to ~2.5 MB (IBM), so 5 MB is generous for every genuine feed.
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return { text: await res.text(), truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function probeHttp() {
  const redirects = [];
  let cur = url.href;
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(cur, {
        redirect: 'manual',
        headers: {
          'User-Agent':
            'vendor-dashboard-watchdog (+https://github.com/bjgreenberg/vendor-dashboard)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        redirects.push({ status: res.status, location: loc });
        cur = new URL(loc, cur).href;
        continue;
      }
      const { text: body, truncated } = await readCapped(res);
      let bodyIsJson = false;
      if (truncated) {
        // Cannot parse a truncated document; a leading { or [ is the honest
        // remaining signal, and the truncation itself is reported as evidence.
        bodyIsJson = /^[\s]*[{[]/.test(body);
      } else {
        try {
          JSON.parse(body);
          bodyIsJson = true;
        } catch {
          /* not JSON — that IS the finding */
        }
      }
      return {
        ok: true,
        status: res.status,
        redirects,
        finalHost: new URL(cur).hostname,
        bodyIsJson,
        ...(truncated ? { bodyTruncatedAtBytes: MAX_BODY_BYTES } : {}),
      };
    }
    // Five redirects without a terminal response: report the loop as-is.
    return { ok: true, status: 310, redirects, finalHost: new URL(cur).hostname, bodyIsJson: false };
  } catch (e) {
    return { ok: false, redirects, error: String(e?.cause?.code ?? e?.name ?? e) };
  }
}

const probe = { host, dns: await probeDns(), tls: await probeTls(), http: await probeHttp() };
const verdict = classify(probe);

console.log(`## ${verdict.headline}

**URL probed:** \`${url.href}\`
**Classification:** \`${verdict.classification}\`

**Suggested fix:** ${verdict.suggestedFix}

### Evidence

\`\`\`json
${JSON.stringify(probe, null, 2)}
\`\`\`
`);
