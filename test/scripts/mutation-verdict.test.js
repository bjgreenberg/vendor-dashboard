/**
 * The Stryker mutation gate's verdict (scripts/mutation-verdict.mjs).
 *
 * Stryker's score is detected/valid and `valid` excludes mutants whose run
 * errored, so an unjudged mutant shrinks the denominator instead of failing
 * the gate — the break threshold cannot see it. The verdict fails on any
 * RuntimeError or CompileError so the gate can.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VERDICT = fileURLToPath(new URL("../../scripts/mutation-verdict.mjs", import.meta.url));

function report(mutants) {
  const dir = mkdtempSync(join(tmpdir(), "mutation-verdict-"));
  const path = join(dir, "mutation.json");
  writeFileSync(path, JSON.stringify({ files: { "src/thing.js": { mutants } } }));
  return path;
}

function run(path) {
  try {
    const stdout = execFileSync("node", [VERDICT, path], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const KILLED = { id: "1", status: "Killed", mutatorName: "EqualityOperator", location: { start: { line: 4 } } };
const SURVIVED = { id: "2", status: "Survived", mutatorName: "BooleanLiteral", location: { start: { line: 9 } } };

describe("mutation verdict", () => {
  it("passes when every mutant was judged", () => {
    const r = run(report([KILLED, SURVIVED]));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Killed 1, Survived 1");
    expect(r.stdout).toContain("PASS: every mutant was judged");
  });

  it("fails on a RuntimeError mutant even though the score would not move", () => {
    const r = run(report([KILLED, { ...SURVIVED, status: "RuntimeError" }]));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("RuntimeError");
    expect(r.stderr).toContain("src/thing.js:9");
    expect(r.stderr).toContain("1 unjudged mutant(s)");
    expect(r.stdout).not.toContain("PASS");
  });

  it("fails on a CompileError mutant", () => {
    const r = run(report([{ ...KILLED, status: "CompileError" }]));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("CompileError");
  });

  it("names at most ten offenders and counts the rest", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...KILLED, id: String(i), status: "RuntimeError" }));
    const r = run(report(many));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("and 2 more");
    expect(r.stderr).toContain("12 unjudged mutant(s)");
  });

  it("an unreadable report is a failure, not a pass", () => {
    const r = run(join(tmpdir(), "definitely-not-here", "mutation.json"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read");
  });

  it("an empty report passes and says so", () => {
    const r = run(report([]));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mutants 0: none");
  });
});
