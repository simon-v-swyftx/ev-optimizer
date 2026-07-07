-- Persisted state-machine snapshot (JSON StoredState from src/tick.ts).
-- days.state stays the human-readable state name for dashboards.
ALTER TABLE days ADD COLUMN state_json TEXT;
