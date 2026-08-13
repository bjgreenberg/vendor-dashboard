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
const url = new URL(raw);
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
      const body = await res.text();
      let bodyIsJson = false;
      try {
        JSON.parse(body);
        bodyIsJson = true;
      } catch {
        /* not JSON — that IS the finding */
      }
      return { ok: true, status: res.status, redirects, finalHost: new URL(cur).hostname, bodyIsJson };
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
