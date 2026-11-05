-- 作业完成改成「孩子勾了，家长确认了才算」：needs_confirm 说这条作业要不要确认，
-- homework_done.confirmed_at 为空就是还挂在家长的待确认列表里，积分到那一刻才进账。
ALTER TABLE homework ADD COLUMN needs_confirm INTEGER NOT NULL DEFAULT 1;
ALTER TABLE homework_done ADD COLUMN confirmed_at TEXT;
-- 已有的勾都已经发过积分了，一律当作确认过：不补这一列的历史，家长一打开就会
-- 看到整片旧勾选堵在待确认列表里，取消勾选还会把已经花掉的分扣成负数。
UPDATE homework_done SET confirmed_at = completed_at WHERE confirmed_at IS NULL;
