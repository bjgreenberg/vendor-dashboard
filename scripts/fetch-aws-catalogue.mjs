#!/usr/bin/env node
/**
 * fetch-aws-catalogue.mjs — snapshot AWS's service list at BUILD time.
 *
 * WHY. The catalogue lives at servicedata-us-east-1-prod.s3.amazonaws.com/
 * services.json: 1.25 MB of 5,848 service-region pairs covering 268 distinct
 * services. Fetching and scanning it inside the collector cost a subrequest
 * plus ~1.7 ms of CPU on every cycle, against a free-plan ceiling of 10 ms per
 * invocation — and on 2026-08-01 that ceiling was being hit, killing collection
 * for over three hours.
 *
 * The list of AWS services changes when AWS launches one. It does not need to
 * be read every fifteen minutes. Snapshotting it here removes the fetch and the
 * scan from the hot path entirely; only the names are kept, so the committed
 * file is a few KB rather than 1.25 MB.
 *
 * Re-run when AWS launches services:  node scripts/fetch-aws-catalogue.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';

const URL_ = 'https://servicedata-us-east-1-prod.s3.amazonaws.com/services.json';
const OUT = 'config/vendors.json';

const res = await fetch(URL_, {
  headers: { 'User-Agent': 'vendor-dashboard/2.0 (+https://briangreenberg.net/service-status; build)' },
});
if (!res.ok) {
  console.error(`AWS catalogue fetch failed: HTTP ${res.status}`);
  process.exit(1);
}

// Served as UTF-16 with a BOM, same as currentevents.
const buf = new Uint8Array(await res.arrayBuffer());
const encoding = buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le' : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : 'utf-8';
const text = new TextDecoder(encoding).decode(buf);

const names = [...new Set([...text.matchAll(/"service_name":"([^"]+)"/g)].map((m) => m[1]))].sort();
if (names.length < 100) {
  console.error(`refusing to write a suspiciously small catalogue (${names.length} services)`);
  process.exit(1);
}

// Written into the vendor's `serviceCatalog`, the field the engine already
// reads for Okta. Keeping it in config rather than a module the engine imports
// preserves the engine's purity — importing JSON there broke `npm run perf`
// under plain Node, which requires an import attribute the bundler does not.
const config = JSON.parse(readFileSync(OUT, 'utf8'));
const aws = config.vendors.find((v) => v.name === 'AWS');
if (!aws) {
  console.error('no AWS vendor in config');
  process.exit(1);
}
const before = aws.serviceCatalog?.length ?? 0;
aws.serviceCatalog = names;
writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `wrote ${names.length} AWS services (was ${before}) into ${OUT} from a ${(buf.length / 1048576).toFixed(2)} MB source`,
);
