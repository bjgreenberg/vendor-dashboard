-- AI-fetch tallies (worklist #127, 2026-09-30): who fetches /service-status/llms.txt
-- and /service-status/index.md, per day, per crawler (src/worker/ai-fetches.js,
-- shared with the three sites). One atomic UPSERT per fetch; the stats read prunes
-- rows past 90 days. The module also creates this table lazily (same statement).
CREATE TABLE IF NOT EXISTS ai_fetches (
  day TEXT NOT NULL, kind TEXT NOT NULL, agent TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, agent));
