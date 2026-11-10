-- Team events: admin-defined team names (JSON array), same shape as divisions.
ALTER TABLE event_config ADD COLUMN teams TEXT;
