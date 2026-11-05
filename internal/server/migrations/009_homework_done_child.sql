-- 作业完成勾选从「家庭级」改成「按孩子」：同一个作业同一天，两个孩子各勾各的、各拿各的分，
-- 谁勾的也不会因为另一个孩子先勾过而拿不到分。旧行必须回填一个孩子：优先认当初记分的
-- 那笔台账（reference_id 还是旧的 `<homework_id>:<date>`），否则记在家庭里最早的孩子头上；
-- 家庭里已经没有孩子的行为孤儿（没有孩子能读到它），直接丢掉。
DROP TABLE IF EXISTS homework_done_new;
CREATE TABLE homework_done_new(
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  homework_id TEXT NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(homework_id,date,child_id)
);
INSERT INTO homework_done_new(family_id,homework_id,child_id,date,completed_at)
SELECT hd.family_id, hd.homework_id,
       COALESCE(
         (SELECT pl.child_id FROM point_ledger pl
           WHERE pl.family_id=hd.family_id AND pl.reference_type='homework'
             AND pl.reference_id=hd.homework_id||':'||hd.date
           LIMIT 1),
         (SELECT c.id FROM children c WHERE c.family_id=hd.family_id
           ORDER BY c.created_at,c.id LIMIT 1)
       ),
       hd.date, hd.completed_at
  FROM homework_done hd
 WHERE EXISTS(SELECT 1 FROM children c WHERE c.family_id=hd.family_id);
DROP TABLE homework_done;
ALTER TABLE homework_done_new RENAME TO homework_done;
CREATE INDEX IF NOT EXISTS idx_homework_done_family_date ON homework_done(family_id,date);
-- 台账 reference_id 带着孩子：唯一键是 (family_id,reference_type,reference_id)，不带孩子
-- 的话第二个孩子勾同一科会被 INSERT OR IGNORE 吞掉，取消时也会扣到第一个孩子头上。
UPDATE point_ledger SET reference_id=reference_id||':'||child_id
 WHERE reference_type IN ('homework','homework_bonus');
