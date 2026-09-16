-- A redemption's completion record: the child says whether the promised wish
-- actually happened, optionally with a written note and their own photos/videos.
ALTER TABLE redemptions ADD COLUMN completed_note TEXT;

-- attachments.submission_id was NOT NULL, so a redemption could not own media.
-- SQLite cannot relax a NOT NULL in place, hence the rebuild; the CHECK keeps
-- every row owned by exactly one submission or one redemption.
CREATE TABLE attachments_new(id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, submission_id TEXT REFERENCES task_submissions(id) ON DELETE CASCADE, redemption_id TEXT REFERENCES redemptions(id) ON DELETE CASCADE, original_name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL CHECK(media_type IN ('image','video')), mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, CHECK((submission_id IS NULL) <> (redemption_id IS NULL)));
INSERT INTO attachments_new(id,family_id,submission_id,redemption_id,original_name,storage_name,media_type,mime_type,size_bytes,created_at) SELECT id,family_id,submission_id,NULL,original_name,storage_name,media_type,mime_type,size_bytes,created_at FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;
CREATE INDEX IF NOT EXISTS idx_attachments_redemption ON attachments(family_id,redemption_id);
