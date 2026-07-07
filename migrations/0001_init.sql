CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE days (
  date TEXT PRIMARY KEY,          -- YYYY-MM-DD Brisbane
  reserve_pct INTEGER NOT NULL,
  planned_at TEXT NOT NULL,       -- ISO timestamp
  state TEXT NOT NULL             -- current state machine state
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  state_from TEXT NOT NULL,
  state_to TEXT NOT NULL,
  action TEXT NOT NULL,           -- e.g. start_charging, set_amps:12, none
  inputs_json TEXT NOT NULL       -- snapshot of every input the decision used
);

CREATE TABLE load_samples (
  date TEXT NOT NULL,             -- YYYY-MM-DD Brisbane
  slot_half_hour INTEGER NOT NULL,-- 0..47
  load_kwh REAL NOT NULL,
  PRIMARY KEY (date, slot_half_hour)
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  kwh_est REAL,
  end_reason TEXT                 -- unplugged | floor | window_end | limit | error
);

INSERT INTO config (key, value) VALUES
  ('safety_factor', '1.3'),
  ('stranded_min_pct', '30'),
  ('evening_dump', 'false'),
  ('window_start_local', '05:30'),
  ('window_end_local', '14:15');
