package server

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

// 二年级两个轻游戏：口算闯关（timed_calc，60 秒速算，score = 答对题数）与找规律
// （pattern_quiz，10 题序列填空，score = 答对题数 × 10 的百分制）。题目全在前端
// 生成（src/features/quizzes.ts），服务端只收成绩——信任级别同华容道上报的步数与
// 作业勾选，只做区间校验。成绩两条去路：game_history 逐局留底（家长端回看），
// game_scores 存每孩子每游戏当天的最好成绩——每一局都按本局得分全额入账，不要求
// 破纪录（每答对一题 1 积分；找规律的百分制按 10 折算）。同一局重发由
// Idempotency-Key 挡住，台账 reference_id 挂 history id，所以每局是一笔独立账。
const (
	quizCalc        = "timed_calc"
	quizPattern     = "pattern_quiz"
	quizCalcMax     = 60 // 60 秒最多答对 60 题；再多就不是手速是脚本
	quizPatternMax  = 100
	quizMaxLevel    = 3
	quizMaxMistakes = 20
	quizHistoryRows = 20
)

// quizSpec 是每个游戏的固定参数：名字、分的换算（百分制的找规律要除以 10 才是
// 积分数）、成绩上限、台账里成绩的单位。新增游戏 = 这里加一行 + 迁移里扩 CHECK 集合。
type quizSpec struct {
	Name  string
	Unit  int    // score → 积分的除数
	Max   int
	Scale string // 台账描述里成绩的单位
}

var quizGames = map[string]quizSpec{
	quizCalc:    {Name: "口算闯关", Unit: 1, Max: quizCalcMax, Scale: "题"},
	quizPattern: {Name: "找规律", Unit: 10, Max: quizPatternMax, Scale: "分"},
}

// quizGameView 是一个游戏在当前孩子眼里的进度：今天最好 + 历史最好 + 局数。
type quizGameView struct {
	Game        string `json:"game"`
	Name        string `json:"name"`
	TodayBest   int    `json:"todayBest"`
	AllTimeBest int    `json:"allTimeBest"`
	TodayPlays  int    `json:"todayPlays"`
	Level       int    `json:"level"`
}

// quizHistoryEntry 是一局成绩（details 解出来原样下发，前端按游戏读字段）。
type quizHistoryEntry struct {
	ID        string          `json:"id"`
	Game      string          `json:"game"`
	Score     int             `json:"score"`
	Details   json.RawMessage `json:"details"`
	CreatedAt string          `json:"createdAt"`
}

type quizPayload struct {
	Games   []quizGameView     `json:"games"`
	History []quizHistoryEntry `json:"history"`
}

// getQuizzes 返回两个游戏的当天/历史最好成绩与该孩子的最近 20 局记录，两端都能读。
// 规则同 getKlotski：池只有一个连接，每段查询先读完关闭再拼下一段。
func (s *Server) getQuizzes(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	loc, err := s.familyLocation(r.Context(), x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	today := s.now().In(loc).Format("2006-01-02")
	// 每游戏一行：当天最好/局数来自当天行，历史最好是全表 MAX。
	type best struct{ today, all, plays, level int }
	bestBy := map[string]best{}
	rows, err := s.db.QueryContext(r.Context(), `SELECT game, MAX(CASE WHEN date=? THEN best_score ELSE 0 END), MAX(best_score), MAX(CASE WHEN date=? THEN plays ELSE 0 END), MAX(CASE WHEN date=? THEN level ELSE 0 END) FROM game_scores WHERE family_id=? AND child_id=? GROUP BY game`, today, today, today, x.FamilyID, x.SelectedChildID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for rows.Next() {
		var game string
		var v best
		if err = rows.Scan(&game, &v.today, &v.all, &v.plays, &v.level); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		bestBy[game] = v
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		s.internalError(w, r, err)
		return
	}
	rows.Close()
	out := quizPayload{Games: make([]quizGameView, 0, len(quizGames)), History: make([]quizHistoryEntry, 0, quizHistoryRows)}
	// 固定顺序：口算闯关在前（它是首页入口默认想展示的那个），新游戏按加进来的顺序补。
	for _, game := range []string{quizCalc, quizPattern} {
		spec := quizGames[game]
		v := bestBy[game]
		out.Games = append(out.Games, quizGameView{Game: game, Name: spec.Name, TodayBest: v.today, AllTimeBest: v.all, TodayPlays: v.plays, Level: v.level})
	}
	history, err := s.db.QueryContext(r.Context(), `SELECT id,game,score,details,created_at FROM game_history WHERE family_id=? AND child_id=? ORDER BY created_at DESC,id LIMIT ?`, x.FamilyID, x.SelectedChildID, quizHistoryRows)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for history.Next() {
		var e quizHistoryEntry
		var details string
		// json.RawMessage 是 []byte，database/sql 不接受把 TEXT 直接扫进去；
		// 先落 string 再转换（内容在服务端写入时已过 json.Marshal，原样回带）。
		if err = history.Scan(&e.ID, &e.Game, &e.Score, &details, &e.CreatedAt); err != nil {
			history.Close()
			s.internalError(w, r, err)
			return
		}
		e.Details = json.RawMessage(details)
		out.History = append(out.History, e)
	}
	if err = history.Err(); err != nil {
		history.Close()
		s.internalError(w, r, err)
		return
	}
	history.Close()
	writeJSON(w, http.StatusOK, out)
}

// submitQuizScore 收一局成绩：game_history 必写，本局得分全额入账（reference_id
// 挂 history id，一局一笔，重发靠 Idempotency-Key 挡）。加分路径与 completeKlotski
// 逐字同构；但这里必须带 Idempotency-Key——同一局的重发不该把同一份积分补两遍
// （华容道的重放只会刷纪录、从不加钱，才免了这把锁）。
func (s *Server) submitQuizScore(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	game := chi.URLParam(r, "game")
	spec, ok := quizGames[game]
	if !ok {
		problem(w, http.StatusNotFound, "not_found", "game not found")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		problem(w, http.StatusBadRequest, "idempotency_required", "Idempotency-Key is required")
		return
	}
	var in struct {
		Score    int  `json:"score"`
		Level    int  `json:"level"`
		Mistakes *int `json:"mistakes"`
		Seconds  *int `json:"seconds"`
	}
	if decode(r, &in) != nil {
		problem(w, http.StatusBadRequest, "invalid_request", "invalid JSON")
		return
	}
	// 区间校验就是全部的信任：分数按游戏的量表来（找规律只收 10 的倍数），档位
	// 只有 1..3，两个游戏的补充字段各查各的上限。
	if in.Score < 0 || in.Score > spec.Max || in.Score%spec.Unit != 0 || in.Level < 1 || in.Level > quizMaxLevel {
		problem(w, http.StatusBadRequest, "invalid_request", "score or level out of range")
		return
	}
	if game == quizPattern && (in.Mistakes == nil || *in.Mistakes < 0 || *in.Mistakes > quizMaxMistakes) {
		problem(w, http.StatusBadRequest, "invalid_request", "mistakes out of range")
		return
	}
	if game == quizCalc && (in.Seconds == nil || *in.Seconds != 60) {
		problem(w, http.StatusBadRequest, "invalid_request", "seconds must be 60")
		return
	}
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	loc, err := s.familyLocation(r.Context(), x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	today := s.now().In(loc).Format("2006-01-02")
	details, err := json.Marshal(in)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	now := nowText(s.now())
	replay, claimed, err := s.claimIdempotencyKey(r.Context(), tx, x, "quiz_score", key, now)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !claimed {
		replayOrConflict(w, replay)
		return
	}
	// 本局得分全额入账，不看当天纪录（纪录只用来展示与存档）。
	awarded := in.Score / spec.Unit
	hid := id("hist")
	_, err = tx.Exec(`INSERT INTO game_scores(family_id,child_id,game,date,best_score,level,plays,detail,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(family_id,child_id,game,date) DO UPDATE SET best_score=max(best_score,excluded.best_score),level=excluded.level,plays=plays+1,detail=excluded.detail,updated_at=excluded.updated_at`, x.FamilyID, x.SelectedChildID, game, today, in.Score, in.Level, 1, string(details), now)
	if err == nil {
		_, err = tx.Exec(`INSERT INTO game_history(id,family_id,child_id,game,score,details,created_at) VALUES(?,?,?,?,?,?,?)`, hid, x.FamilyID, x.SelectedChildID, game, in.Score, string(details), now)
		if err == nil && awarded > 0 {
			// 成长值与等级重算公式同 completeKlotski / awardPoints。
			growth := max(awarded/5, 1)
			refID := game + ":round:" + hid
			_, err = tx.Exec(`UPDATE children SET points_balance=points_balance+?,experience=experience+?,level=1+CAST((experience+?)/100 AS INTEGER) WHERE id=? AND family_id=?`, awarded, growth, growth, x.SelectedChildID, x.FamilyID)
			if err == nil {
				// 普通 INSERT：唯一键冲突只可能来自脏数据（同一局被记了两遍），
				// 宁可回滚丢一次领奖，也不能记出两笔。
				_, err = tx.Exec(`INSERT INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,?,'earned','game',?,?,?)`, id("led"), x.FamilyID, x.SelectedChildID, awarded, refID, spec.Name+"："+strconv.Itoa(in.Score)+" "+spec.Scale, now)
			}
		}
		if err == nil {
			_, err = tx.Exec(`INSERT INTO idempotency_keys(family_id,actor_id,operation,key,status_code,response_body,created_at) VALUES(?,?,'quiz_score',?,200,'{}',?) ON CONFLICT(family_id,actor_id,operation,key) DO UPDATE SET status_code=excluded.status_code,response_body=excluded.response_body`, x.FamilyID, x.ActorID, key, now)
		}
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"awarded": awarded})
}
