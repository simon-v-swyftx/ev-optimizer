-- Config rows seeded by 0001 that nothing ever read: the operating window
-- comes from wrangler.jsonc vars (DAY_START, SOLAR_SOAK_END) and the
-- evening dump was never implemented (SPEC "DONE").
DELETE FROM config WHERE key IN ('evening_dump', 'window_start_local', 'window_end_local');
-- Never written: session ownership lives in days.state_json, the audit
-- trail in decisions (SPEC build order, step 4).
DROP TABLE IF EXISTS sessions;
