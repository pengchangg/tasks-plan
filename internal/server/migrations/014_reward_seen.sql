-- 到账庆祝游标：孩子端弹过哪一批到账现在只记在浏览器内存里，一封页就全丢，
-- 换台设备又从头弹一遍。游标落在孩子身上，客户端只补发它之后的 earned 台账，
-- 走完队列再推进它。
ALTER TABLE children ADD COLUMN rewards_seen_at TEXT NOT NULL DEFAULT '';
-- 存量家庭的到账按现状算「已经看过」：升级那一刻不该把整部历史重放一遍。
UPDATE children SET rewards_seen_at = COALESCE((SELECT MAX(created_at) FROM point_ledger p WHERE p.family_id = children.family_id AND p.child_id = children.id AND p.entry_type = 'earned'), '');
