CREATE TABLE round_shot_ledgers (
  event_result_id INTEGER UNIQUE REFERENCES results(id) ON DELETE CASCADE,
  casual_result_id INTEGER UNIQUE REFERENCES casual_results(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  ledger_json TEXT NOT NULL,
  CHECK ((event_result_id IS NULL) != (casual_result_id IS NULL))
);
