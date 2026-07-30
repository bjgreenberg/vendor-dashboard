-- D1 schema for vendor-dashboard.
--
-- Two tables, deliberately:
--   snapshot  the current board. Replaced wholesale each run, inside a
--             transaction, so a reader never sees a half-written board
--             (audit finding M3: the predecessor cleared the sheet and THEN
--             wrote, leaving it blank if the write failed).
--   history   append-only. Costs ~10 lines now and enables uptime %, MTTR and
--             incident timelines later; retrofitting storage would be a
--             migration.

CREATE TABLE IF NOT EXISTS snapshot (
  vendor        TEXT PRIMARY KEY,
  service       TEXT NOT NULL,
  severity      TEXT NOT NULL,
  incident_name TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  source_url    TEXT NOT NULL DEFAULT '',
  components    TEXT NOT NULL DEFAULT '[]',  -- JSON array of children
  warnings      TEXT NOT NULL DEFAULT '[]',  -- JSON array
  checked_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor     TEXT NOT NULL,
  severity   TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_vendor_time ON history (vendor, checked_at);

-- Single-row table describing the most recent run, so the dashboard can show
-- freshness and a monitor can alert when collection silently stops.
CREATE TABLE IF NOT EXISTS run_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT NOT NULL,
  total      INTEGER NOT NULL,
  impacted   INTEGER NOT NULL,
  unknown    INTEGER NOT NULL,
  warnings   TEXT NOT NULL DEFAULT '[]'
);
