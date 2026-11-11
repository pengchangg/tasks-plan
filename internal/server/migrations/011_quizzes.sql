-- 二年级两个轻游戏的成绩表：口算闯关（timed_calc，60 秒速算，score = 答对题数）
-- 与找规律（pattern_quiz，10 题序列填空，score = 10 × 答对题数的百分制）。
-- game_scores 按「每孩子每游戏每天」一行存当天最好成绩（plays 数局数）；加分只补
-- 当天最好成绩的涨幅，UNIQUE 幂等键 + reference_id 带日期/孩子/分数保证同日不重复
-- 入账。game_history 逐局留底（score + details JSON），家长端回看就是读它。
-- CHECK 锁死类型集合：之后新增游戏是加迁移，不是往表里塞脏行。
CREATE TABLE IF NOT EXISTS game_scores(
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK(game IN ('timed_calc','pattern_quiz')),
  date TEXT NOT NULL,
  best_score INTEGER NOT NULL CHECK(best_score>=0),
  level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 3),
  plays INTEGER NOT NULL CHECK(plays>0),
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(family_id,child_id,game,date)
);
CREATE TABLE IF NOT EXISTS game_history(
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK(game IN ('timed_calc','pattern_quiz')),
  score INTEGER NOT NULL CHECK(score>=0),
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_history_child ON game_history(family_id,child_id,created_at);
