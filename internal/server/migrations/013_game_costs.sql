-- 游戏扣分：家长端可设「每次游玩」「每次提示」各扣多少积分，0 表示免费。
-- 默认 0，存量家庭升级后仍是免费，由家长在 /parent/games 主动开启。
ALTER TABLE families ADD COLUMN game_play_cost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE families ADD COLUMN game_hint_cost INTEGER NOT NULL DEFAULT 0;
