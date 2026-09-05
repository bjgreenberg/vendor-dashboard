-- Truth-check stamp (spec: docs/superpowers/specs/2026-09-05-truth-check-design.md).
-- One row: the last time the external truth-check workflow compared the board
-- with the vendors' own feeds, and what it found. Written by the workflow via
-- POST /api/truth-check (bearer token); read by the board's stamp and
-- /api/status. Row absent = never checked; a stale row is itself the alarm.
CREATE TABLE IF NOT EXISTS truth_check (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at    TEXT NOT NULL,
  covered       INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  agreed        INTEGER NOT NULL,
  disagreements INTEGER NOT NULL,
  detail        TEXT NOT NULL
);
