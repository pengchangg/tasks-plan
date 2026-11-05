-- 取消完成时扣回的积分可能超过余额，children.points_balance 得允许为负（兑换仍要求
-- points_balance>=cost，负余额兑不了）。SQLite 改不了 CHECK，只能重建表。
--
-- 这段必须在 PRAGMA foreign_keys=OFF 下跑（见 runMigration 的注释）：引用 children 的
-- 七张表都写着 ON DELETE CASCADE，外键开着时 DROP TABLE children 会把它们真的清空，
-- defer_foreign_keys 拦不住这一刀（2026-11-05 线上整月记录就是这么没的）。
-- 关掉外键后 DROP 不再级联，改名也不会把别表的外键子句指向中间表名，数据原样留下。
DROP TABLE IF EXISTS children_new;
CREATE TABLE children_new(id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, name TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, experience REAL NOT NULL DEFAULT 0, points_balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
INSERT INTO children_new SELECT id,family_id,name,avatar,color,level,experience,points_balance,created_at FROM children;
DROP TABLE children;
ALTER TABLE children_new RENAME TO children;
