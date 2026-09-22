#!/usr/bin/env node
/**
 * Verdict for the nightly Stryker mutation gate.
 *
 * Stryker's mutation score is detected / valid, and `valid` EXCLUDES mutants
 * whose run errored: RuntimeError and CompileError land in `totalInvalid` and
 * leave the denominator entirely (mutation-testing-metrics, calculateMetrics).
 * So a mutant nobody judged does not lower the score — it disappears from it,
 * and the break threshold can never notice.
 *
 * That blind spot is not hypothetical. mutmut has the same shape one level
 * milder: it files an unrecognised worker exit under `suspicious`, and for
 * three nights (2026-09-15 to 17) a crashed worker in meeting-journal left an
 * unjudged mutant while the gate reported a pass (meeting-journal#52).
 *
 * This runs after `stryker run` and fails when any mutant errored, so an
 * unjudged mutant is a red gate rather than a smaller denominator.
 *
 * Usage: node scripts/mutation-verdict.mjs [path/to/mutation.json]
 * Exit 0 clean, 1 unjudged mutants or an unreadable report.
 */
import { readFileSync } from "node:fs";

const REPORT = process.argv[2] ?? "reports/mutation/mutation.json";
const UNJUDGED = ["RuntimeError", "CompileError"];

function main() {
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch (err) {
    process.stderr.write(`FAIL: cannot read ${REPORT}: ${err.message}\n`);
    return 1;
  }
  const mutants = Object.entries(report.files ?? {}).flatMap(([file, f]) =>
    (f.mutants ?? []).map((m) => ({ ...m, file })),
  );
  const counts = {};
  for (const m of mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const summary = Object.keys(counts)
    .sort()
    .map((k) => `${k} ${counts[k]}`)
    .join(", ");
  process.stdout.write(`mutants ${mutants.length}: ${summary || "none"}\n`);

  const bad = mutants.filter((m) => UNJUDGED.includes(m.status));
  if (bad.length === 0) {
    process.stdout.write("PASS: every mutant was judged\n");
    return 0;
  }
  for (const m of bad.slice(0, 10)) {
    process.stderr.write(
      `FAIL: ${m.status} — ${m.file}:${m.location?.start?.line ?? "?"} ${m.mutatorName ?? ""} ` +
        `— this mutant was never judged, and Stryker leaves it OUT of the score\n`,
    );
  }
  if (bad.length > 10) process.stderr.write(`FAIL: ... and ${bad.length - 10} more\n`);
  process.stderr.write(`FAIL: ${bad.length} unjudged mutant(s)\n`);
  return 1;
}

process.exit(main());
