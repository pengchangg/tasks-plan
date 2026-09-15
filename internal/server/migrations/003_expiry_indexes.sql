-- Expiry sweeps: sessions expire 12h (parent) / 30d (child) and idempotency
-- keys are retained for 30d, but nothing deletes either automatically.
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
