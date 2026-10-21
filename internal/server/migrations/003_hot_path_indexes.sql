-- /state 每次刷新都会读一遍本家庭的附件与账本：
-- 提交证据走 attachments JOIN task_submissions ON s.id=a.submission_id，
-- 而 001 只给 (family_id,redemption_id) 建了索引，于是这条查询每次都全表扫；
-- 连续天数走 point_ledger WHERE family_id=? AND entry_type='earned' ORDER BY created_at，
-- 001 的 idx_ledger_child 前导列是 child_id，帮不上家庭级的范围扫描。
CREATE INDEX IF NOT EXISTS idx_attachments_submission ON attachments(family_id,submission_id);
CREATE INDEX IF NOT EXISTS idx_ledger_family_created ON point_ledger(family_id,created_at);
