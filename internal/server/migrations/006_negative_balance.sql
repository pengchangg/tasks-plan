-- 取消作业完成时积分可能已经被孩子花掉，所以 children.points_balance 允许为负（欠分），
-- 而兑换心愿仍然要求余额足够（redeemWish 的 points_balance>=cost）。SQLite 改不了 CHECK，
-- 只能重建表；DROP 触发的隐式 DELETE 会把外键检查推到提交时（defer_foreign_keys），
-- 提交时新表已经以同一个名字就位，所以其它表的外键仍然成立。
PRAGMA defer_foreign_keys=ON;
DROP TABLE IF EXISTS children_new;
CREATE TABLE children_new(id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, name TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, experience REAL NOT NULL DEFAULT 0, points_balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
INSERT INTO children_new SELECT id,family_id,name,avatar,color,level,experience,points_balance,created_at FROM children;
DROP TABLE children;
ALTER TABLE children_new RENAME TO children;
