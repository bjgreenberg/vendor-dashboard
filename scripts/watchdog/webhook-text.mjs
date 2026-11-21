#!/usr/bin/env node
/**
 * Prints the webhook payload ({"text": ...}) for a newly filed endpoint-rot
 * issue: node scripts/watchdog/webhook-text.mjs VENDOR HOURS ISSUE_URL BODY_FILE.
 * The text is classify.mjs's webhookText, which names what the diagnosis in
 * BODY_FILE found (endpoint-rot-watchdog.yml).
 */
import { readFileSync } from 'node:fs';
import { classificationIn, webhookText } from './classify.mjs';

const [vendor, hours, issueUrl, bodyFile] = process.argv.slice(2);
if (!vendor || !hours || !issueUrl || !bodyFile) {
  console.error('usage: webhook-text.mjs VENDOR HOURS ISSUE_URL BODY_FILE');
  process.exit(2);
}
const body = readFileSync(bodyFile, 'utf8');
console.log(JSON.stringify({ text: webhookText(vendor, hours, issueUrl, classificationIn(body)) }));
