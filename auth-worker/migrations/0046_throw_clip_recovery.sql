-- Device-generated upload IDs make retries safe after an interrupted response.
ALTER TABLE throw_clips ADD COLUMN client_id TEXT;

CREATE UNIQUE INDEX idx_throw_clips_client_op
  ON throw_clips(scope, scope_key, filmed_by, client_id)
  WHERE client_id IS NOT NULL;
