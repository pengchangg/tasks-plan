-- 孩子端作业卡片的「完成」勾选：按天记录，所以一条假期作业（date..end_date）能在区间内
-- 逐天勾选。homework 删除时级联清理（要求 foreign_keys=ON，Open 时已开）。
CREATE TABLE homework_done(family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, homework_id TEXT NOT NULL REFERENCES homework(id) ON DELETE CASCADE, date TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY(homework_id,date));
