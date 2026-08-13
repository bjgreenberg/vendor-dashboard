-- Endpoint-rot watchdog (spec: docs/superpowers/specs/2026-08-12-endpoint-rot-watchdog-design.md).
-- One row per vendor CURRENTLY failing: failing_since is the first unknown of
-- the active streak, failures the consecutive count. Row absent = healthy.
-- Written by writeRun in the same transactional batch as the snapshot;
-- budget-exhausted runs neither start nor clear streaks (operator fault,
-- not vendor rot).
CREATE TABLE IF NOT EXISTS vendor_health (
  vendor        TEXT PRIMARY KEY,
  failing_since TEXT NOT NULL,
  failures      INTEGER NOT NULL
);
