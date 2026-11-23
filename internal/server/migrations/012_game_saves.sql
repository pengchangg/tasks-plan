-- 游戏断点存档：孩子离开游戏页再回来，进度不该白丢。每孩子每游戏槽一行（华容道
-- 每关一个槽，槽名 klotski:<level>；口算、找规律各一个槽），state 是写入它的那一端
-- 定义的 JSON。服务端不解释 state，只校验大小与 JSON 合法性，所以这里不加 CHECK：
-- 槽名白名单（含随关卡变化的 klotski:<level>）在 Go 的 validGameSaveKey 里维护，
-- 加关卡不该需要一次迁移。通关、交卷、主动重开都由客户端 DELETE 掉对应的行。
CREATE TABLE IF NOT EXISTS game_saves(
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(family_id,child_id,game)
);
