CREATE TABLE member_practice_records (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('disc', 'throw', 'putting')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  occurred_on TEXT NOT NULL,
  payload TEXT,
  last_op TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);

CREATE INDEX member_practice_history ON member_practice_records(owner, kind, occurred_on DESC, id DESC)
  WHERE payload IS NOT NULL;

CREATE TABLE member_practice_operations (
  owner TEXT NOT NULL,
  op_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claim TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, op_id)
);

CREATE INDEX member_practice_operations_age ON member_practice_operations(owner, created_at DESC);
