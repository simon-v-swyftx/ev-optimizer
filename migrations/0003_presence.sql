-- Latest "car is home" report from a bluetooth scanner (or any webhook),
-- written by POST /presence and read by the tick when D1 config
-- home_detection uses bluetooth (src/presence.ts). Single row.
CREATE TABLE presence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  home INTEGER NOT NULL,          -- 1 = car seen, 0 = car not seen
  reported_at TEXT NOT NULL,      -- ISO timestamp (Worker clock)
  source TEXT                     -- free text from the reporter, for the log
);
