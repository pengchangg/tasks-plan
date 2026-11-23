package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
)

// 游戏扣分：家长端设两个数字——每次游玩扣多少、每次提示扣多少（0 = 免费），
// 孩子开新局/重新开始一关/点一次提示时各有一次真实扣款。扣款是钱包写入，所以
// 与 submit/review/redeem 同级：必须带 Idempotency-Key，重发同键回存下的状态、
// 不会扣两遍；余额不足直接拒绝（UPDATE 带 points_balance>=cost 守卫，理由同
// redeemWish——余额不会因为玩游戏变负）。「续上次」的断点存档免费，所以这里只
// 记录「这一次新开局」的消费，状态本身由 game_saves 管。
const gameCostMax = 500

// GameCosts 既是 /state 的下发字段，也是 PUT /games/costs 的请求体：字段集合
// 一一对应，前端可以直接把它当写请求类型用（decode 开着 DisallowUnknownFields）。
type GameCosts struct {
	PlayCost int `json:"playCost"`
	HintCost int `json:"hintCost"`
}

func (s *Server) gameCostValues(ctx context.Context, family string) (play, hint int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT game_play_cost,game_hint_cost FROM families WHERE id=?`, family).Scan(&play, &hint)
	return play, hint, err
}

// gameSlotName 把断点槽名翻成台账里读得懂的名字（槽名白名单见 validGameSaveKey）。
func gameSlotName(key string) string {
	switch key {
	case quizCalc:
		return quizGames[quizCalc].Name
	case quizPattern:
		return quizGames[quizPattern].Name
	}
	if level, err := strconv.Atoi(strings.TrimPrefix(key, "klotski:")); err == nil {
		if _, ok := klotskiLevels[level]; ok {
			return "华容道第" + strconv.Itoa(level) + "关"
		}
	}
	return key
}

// saveGameCosts 是家长端唯一的写入口：两个数字都必填、都在 0…500 之间（与手动
// 调分的上限一致），0 表示该项免费。
func (s *Server) saveGameCosts(w http.ResponseWriter, r *http.Request) {
	var in GameCosts
	if decode(r, &in) != nil || in.PlayCost < 0 || in.PlayCost > gameCostMax || in.HintCost < 0 || in.HintCost > gameCostMax {
		problem(w, http.StatusBadRequest, "invalid_request", "cost must be between 0 and 500")
		return
	}
	x := sess(r)
	if _, err := s.db.ExecContext(r.Context(), `UPDATE families SET game_play_cost=?,game_hint_cost=? WHERE id=?`, in.PlayCost, in.HintCost, x.FamilyID); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, in)
}

func (s *Server) chargePlay(w http.ResponseWriter, r *http.Request) { s.chargeGame(w, r, false) }

func (s *Server) chargeHint(w http.ResponseWriter, r *http.Request) { s.chargeGame(w, r, true) }

// chargeGame 收一次游玩/提示的扣款。price 为 0 时不动钱包也不占幂等键，直接回
// 当前余额（客户端据此说「已扣 0 分」这类话）；有价时才进事务，按「先抢幂等键、
// 再扣余额、再记台账」的顺序写，与 submitTask 的花钱镜像一一对应。
func (s *Server) chargeGame(w http.ResponseWriter, r *http.Request, hint bool) {
	var in struct {
		Game string `json:"game"`
	}
	if decode(r, &in) != nil {
		problem(w, http.StatusBadRequest, "invalid_request", "invalid JSON")
		return
	}
	// 槽名白名单与断点存档同一份，所以新关卡不用改这两个接口；提示只有华容道有。
	if !validGameSaveKey(in.Game) || (hint && !strings.HasPrefix(in.Game, "klotski:")) {
		problem(w, http.StatusNotFound, "not_found", "game not found")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		problem(w, http.StatusBadRequest, "idempotency_required", "Idempotency-Key is required")
		return
	}
	x := sess(r)
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	play, hintCost, err := s.gameCostValues(r.Context(), x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	cost, action, operation, kind := play, "开始一局", "game_play", "play"
	if hint {
		cost, action, operation, kind = hintCost, "使用提示", "game_hint", "hint"
	}
	if cost == 0 {
		var balance int
		if err := s.db.QueryRowContext(r.Context(), `SELECT points_balance FROM children WHERE id=? AND family_id=?`, x.SelectedChildID, x.FamilyID).Scan(&balance); err != nil {
			s.internalError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"cost": 0, "balance": balance})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	now := nowText(s.now())
	replay, claimed, err := s.claimIdempotencyKey(r.Context(), tx, x, operation, key, now)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !claimed {
		replayOrConflict(w, replay)
		return
	}
	// 余额守卫写在 UPDATE 里（同 redeemWish）：扣不动就是积分不足，余额永不为负。
	res, err := tx.Exec(`UPDATE children SET points_balance=points_balance-? WHERE id=? AND family_id=? AND points_balance>=?`, cost, x.SelectedChildID, x.FamilyID, cost)
	var changed int64
	if err == nil {
		changed, err = res.RowsAffected()
	}
	if err == nil && changed != 1 {
		// 回滚把这次幂等键的占位也一起撤掉，孩子攒够分后重试能重新计费。
		problem(w, http.StatusConflict, "insufficient_points", "not enough points")
		return
	}
	ledID := id("led")
	if err == nil {
		// 消费不改成长值与等级（同兑换）。
		_, err = tx.Exec(`INSERT INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,?,'spent','game',?,?,?)`, ledID, x.FamilyID, x.SelectedChildID, -cost, in.Game+":"+kind+":"+ledID, gameSlotName(in.Game)+"："+action, now)
	}
	var balance int
	if err == nil {
		err = tx.QueryRow(`SELECT points_balance FROM children WHERE id=? AND family_id=?`, x.SelectedChildID, x.FamilyID).Scan(&balance)
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE idempotency_keys SET status_code=200 WHERE family_id=? AND actor_id=? AND operation=? AND key=?`, x.FamilyID, x.ActorID, operation, key)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"cost": cost, "balance": balance})
}
