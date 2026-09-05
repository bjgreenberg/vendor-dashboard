#!/usr/bin/env node
/**
 * truth-check/run.mjs — fetch every covered vendor's raw feed and compare the
 * vendor's own verdict with what the board renders.
 *
 *   node scripts/truth-check/run.mjs <status.json> [config/vendors.json] [--out report.json]
 *
 * status.json is the board (/api/status, fetched by the workflow from the
 * workers.dev origin). Stdout gets a Markdown summary the workflow pastes into
 * its log and issues; --out gets the machine-readable report. Exit code is
 * always 0 — deciding what a disagreement means (issue, email, stamp) is the
 * workflow's job, and a fetch failure here is `unreadable`, never a crash and
 * never a silent "fine".
 *
 * The rules live in rules.mjs and are unit-tested against recorded payloads;
 * this file is the thin network half (same split as the watchdog's
 * diagnose-endpoint.mjs / classify.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { probeUrlsFor, secondOpinion, compare } from './rules.mjs';

const UA = 'vendor-dashboard-truth-check/1 (+https://github.com/bjgreenberg/vendor-dashboard; second-opinion probe)';
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024; // the largest covered feed (Google) is ~0.4 MB; oracle's 1.6 MB components doc is not fetched
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
const positional = args.filter((a, i) => a !== '--out' && (outIdx === -1 || i !== outIdx + 1));
const statusPath = positional[0];
const configPath = positional[1] ?? 'config/vendors.json';
if (!statusPath) {
  console.error('usage: run.mjs <status.json> [vendors.json] [--out report.json]');
  process.exit(2);
}

const status = JSON.parse(readFileSync(statusPath, 'utf8'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const records = Array.isArray(status?.records) ? status.records : [];

/** @param {string} url */
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) return { error: `body ${len} bytes exceeds cap` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { error: `body ${buf.length} bytes exceeds cap` };
    // Some feeds ship a BOM or a JSON-with-charset header; strip and parse.
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    try {
      return JSON.parse(text);
    } catch {
      return { error: `not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…)` };
    }
  } catch (err) {
    return { error: err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS} ms` : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const vendors = Array.isArray(config?.vendors) ? config.vendors : [];
const urls = [...new Set(vendors.flatMap((v) => probeUrlsFor(v)))];
const bodies = {};
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  const slice = urls.slice(i, i + CONCURRENCY);
  const got = await Promise.all(slice.map((u) => fetchJson(u)));
  slice.forEach((u, j) => {
    bodies[u] = got[j];
  });
}

const opinions = new Map(vendors.map((v) => [v.name, secondOpinion(v, bodies)]));
const result = compare(records, opinions);
const uncovered = vendors.filter((v) => !opinions.get(v.name)?.covered).map((v) => v.name);
const report = {
  checkedAt: new Date().toISOString(),
  ruleVersion: 1,
  total: result.total,
  covered: result.covered,
  agreed: result.agreed,
  falseGreen: result.falseGreen,
  overCautious: result.overCautious,
  unreadable: result.unreadable,
  uncovered,
};
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

const lines = [];
lines.push(`truth-check ${report.checkedAt}: ${report.covered}/${report.total} vendors covered, ${report.agreed} agree, ${report.falseGreen.length} FALSE GREEN, ${report.overCautious.length} over-cautious, ${report.unreadable.length} unreadable, ${uncovered.length} uncovered`);
for (const f of report.falseGreen) {
  lines.push(`\nFALSE GREEN — ${f.vendor}: board renders \`${f.rendered}\`, vendor says otherwise`);
  for (const e of f.evidence) lines.push(`  - ${e}`);
  for (const u of f.urls) lines.push(`  - source: ${u}`);
}
for (const o of report.overCautious) lines.push(`over-cautious — ${o.vendor}: board \`${o.rendered}\`, vendor fine (${o.evidence.join(' | ')})`);
if (report.unreadable.length) lines.push(`unreadable: ${report.unreadable.join(', ')}`);
if (uncovered.length) lines.push(`uncovered (no rule for the platform): ${uncovered.join(', ')}`);
console.log(lines.join('\n'));
