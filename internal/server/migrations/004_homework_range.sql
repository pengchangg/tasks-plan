-- 一条作业可以覆盖一整段连续假期（春节 9 天、国庆 7 天、周末 2 天）：孩子端在区间内
-- 每一天都能看到它。end_date 含当天，缺省等于 date（老行先留空串再回填，因为
-- ALTER TABLE ADD COLUMN 的 DEFAULT 只能是常量）。
ALTER TABLE homework ADD COLUMN end_date TEXT NOT NULL DEFAULT '';
UPDATE homework SET end_date=date WHERE end_date='';
CREATE INDEX IF NOT EXISTS idx_homework_family_end ON homework(family_id,end_date);
