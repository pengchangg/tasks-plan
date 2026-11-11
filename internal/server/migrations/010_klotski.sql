-- 华容道进度按孩子存档：每关一行，best_moves 是已知最少步数；
-- 首次通关才记积分（PRIMARY KEY + INSERT OR IGNORE 保证每关只记一次）。
CREATE TABLE IF NOT EXISTS klotski_progress(
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 5),
  best_moves INTEGER NOT NULL CHECK(best_moves>0),
  completed_at TEXT NOT NULL,
  PRIMARY KEY(family_id,child_id,level)
);
