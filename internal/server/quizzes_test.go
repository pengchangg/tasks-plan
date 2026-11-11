package server

import (
	"context"
	"encoding/json"
	"testing"
)

// TestQuizScoresCreditDailyBestDeltasOncePerChildAndNeverDoublePay drives the
// whole quiz surface: the read payload shape, every 400 branch of the score
// range, the daily-best delta credit with its ledger row, a lower round that
// awards nothing while still counting as a play, a replayed key that must not
// move anything, the per-child wall, and the parent end reading the same rows.
func TestQuizScoresCreditDailyBestDeltasOncePerChildAndNeverDoublePay(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	cookie := childCookie(t, h, "")

	type gameView struct {
		Game        string `json:"game"`
		Name        string `json:"name"`
		TodayBest   int    `json:"todayBest"`
		AllTimeBest int    `json:"allTimeBest"`
		TodayPlays  int    `json:"todayPlays"`
		Level       int    `json:"level"`
	}
	type historyEntry struct {
		ID      string          `json:"id"`
		Game    string          `json:"game"`
		Score   int             `json:"score"`
		Details json.RawMessage `json:"details"`
	}
	getPayload := func() ([]gameView, []historyEntry) {
		w := doJSON(t, h, "GET", "/api/v1/games/quizzes", nil, cookie, "")
		if w.Code != 200 {
			t.Fatalf("get quizzes: %d %s", w.Code, w.Body.String())
		}
		var payload struct {
			Games   []gameView     `json:"games"`
			History []historyEntry `json:"history"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Games, payload.History
	}

	games, history := getPayload()
	if len(games) != 2 || games[0].Game != quizCalc || games[1].Game != quizPattern {
		t.Fatalf("initial games: %+v", games)
	}
	for _, g := range games {
		if g.TodayBest != 0 || g.AllTimeBest != 0 || g.TodayPlays != 0 || g.Level != 0 {
			t.Fatalf("initial %s: %+v", g.Game, g)
		}
	}
	if history == nil || len(history) != 0 {
		t.Fatalf("initial history: %v", history)
	}

	// 分数区间的每一支都得到各自的 400/404；幂等键缺失先于一切。
	if w := doJSON(t, h, "POST", "/api/v1/games/quizzes/timed_calc/score", map[string]any{"score": 5, "level": 1, "seconds": 60}, cookie, ""); w.Code != 400 {
		t.Fatalf("missing key: %d %s", w.Code, w.Body.String())
	}
	if w := doJSON(t, h, "POST", "/api/v1/games/quizzes/sudoku/score", map[string]any{"score": 5, "level": 1, "seconds": 60}, cookie, "k-unknown"); w.Code != 404 {
		t.Fatalf("unknown game: %d %s", w.Code, w.Body.String())
	}
	badBodies := []struct {
		game string
		key  string
		body map[string]any
	}{
		{quizCalc, "k-over", map[string]any{"score": 61, "level": 1, "seconds": 60}},
		{quizCalc, "k-seconds", map[string]any{"score": 5, "level": 1, "seconds": 30}},
		{quizCalc, "k-level", map[string]any{"score": 5, "level": 4, "seconds": 60}},
		{quizPattern, "k-scale", map[string]any{"score": 35, "level": 1, "mistakes": 0}},
		{quizPattern, "k-nomistakes", map[string]any{"score": 40, "level": 1}},
	}
	for _, bad := range badBodies {
		if w := doJSON(t, h, "POST", "/api/v1/games/quizzes/"+bad.game+"/score", bad.body, cookie, bad.key); w.Code != 400 {
			t.Fatalf("bad body %s: %d %s", bad.key, w.Code, w.Body.String())
		}
	}

	before := getStateTest(t, h, cookie)
	balanceBefore, experienceBefore := before.Children[0].PointsBalance, before.Children[0].Experience
	score := func(game, key string, body map[string]any) int {
		w := doJSON(t, h, "POST", "/api/v1/games/quizzes/"+game+"/score", body, cookie, key)
		if w.Code != 200 {
			t.Fatalf("score %s: %d %s", game, w.Code, w.Body.String())
		}
		var out struct {
			Awarded int `json:"awarded"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.Awarded
	}

	// 口算 12 题：一分一题，首局全额。
	if awarded := score(quizCalc, "k-calc-12", map[string]any{"score": 12, "level": 1, "seconds": 60}); awarded != 12 {
		t.Fatalf("calc first round: %d", awarded)
	}
	games, history = getPayload()
	if games[0].TodayBest != 12 || games[0].TodayPlays != 1 || len(history) != 1 {
		t.Fatalf("after calc 12: %+v %d", games[0], len(history))
	}
	// 更低的一局：记局数、进历史，但零加分（当天最好没动）。
	if awarded := score(quizCalc, "k-calc-8", map[string]any{"score": 8, "level": 1, "seconds": 60}); awarded != 0 {
		t.Fatalf("calc lower round: %d", awarded)
	}
	games, history = getPayload()
	if games[0].TodayBest != 12 || games[0].TodayPlays != 2 || len(history) != 2 {
		t.Fatalf("after calc 8: %+v %d", games[0], len(history))
	}
	// 破纪录只补差价：15 − 12 = 3。
	if awarded := score(quizCalc, "k-calc-15", map[string]any{"score": 15, "level": 2, "seconds": 60}); awarded != 3 {
		t.Fatalf("calc better round: %d", awarded)
	}
	games, _ = getPayload()
	if games[0].TodayBest != 15 || games[0].AllTimeBest != 15 || games[0].TodayPlays != 3 || games[0].Level != 2 {
		t.Fatalf("after calc 15: %+v", games[0])
	}
	// 同一把幂等键重放：答案 200 replayed，加分、局数、历史全都不动。
	replay := doJSON(t, h, "POST", "/api/v1/games/quizzes/"+quizCalc+"/score", map[string]any{"score": 15, "level": 2, "seconds": 60}, cookie, "k-calc-15")
	if replay.Code != 200 {
		t.Fatalf("replay status: %d %s", replay.Code, replay.Body.String())
	}
	var replayed map[string]bool
	if err := json.Unmarshal(replay.Body.Bytes(), &replayed); err != nil {
		t.Fatal(err)
	}
	if !replayed["replayed"] {
		t.Fatalf("replay body: %v", replayed)
	}
	games, history = getPayload()
	if games[0].TodayPlays != 3 || len(history) != 3 {
		t.Fatalf("replay moved rows: %+v %d", games[0], len(history))
	}

	// 找规律按百分制收分：70 分记 7 积分，100 分补差价 3。
	if awarded := score(quizPattern, "k-pat-70", map[string]any{"score": 70, "level": 2, "mistakes": 2}); awarded != 7 {
		t.Fatalf("pattern first round: %d", awarded)
	}
	if awarded := score(quizPattern, "k-pat-100", map[string]any{"score": 100, "level": 3, "mistakes": 0}); awarded != 3 {
		t.Fatalf("pattern best round: %d", awarded)
	}
	games, history = getPayload()
	if games[1].TodayBest != 100 || games[1].AllTimeBest != 100 || games[1].TodayPlays != 2 || games[1].Level != 3 {
		t.Fatalf("after pattern rounds: %+v", games[1])
	}
	// 历史按时间倒序，details 原样回带（前端按游戏解字段）。
	if history[0].Game != quizPattern || history[0].Score != 100 || !json.Valid(history[0].Details) {
		t.Fatalf("newest history: %+v", history[0])
	}

	after := getStateTest(t, h, cookie)
	if after.Children[0].PointsBalance != balanceBefore+15+10 {
		t.Fatalf("balance: %d -> %d", balanceBefore, after.Children[0].PointsBalance)
	}
	// 成长值 = 各笔加分的 max(加分/5,1) 之和：2+1+1+1。
	if after.Children[0].Experience != experienceBefore+5 {
		t.Fatalf("experience: %v -> %v", experienceBefore, after.Children[0].Experience)
	}
	family, _, err := s.resolvedFamily(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ledgerRows, ledgerSum int
	if err = s.db.QueryRow(`SELECT COUNT(*),COALESCE(SUM(amount),0) FROM point_ledger WHERE family_id=? AND reference_type='game' AND reference_id LIKE 'timed_calc:%'`, family).Scan(&ledgerRows, &ledgerSum); err != nil {
		t.Fatal(err)
	}
	if ledgerRows != 2 || ledgerSum != 15 {
		t.Fatalf("calc ledger: %d %d", ledgerRows, ledgerSum)
	}
	if err = s.db.QueryRow(`SELECT COUNT(*),COALESCE(SUM(amount),0) FROM point_ledger WHERE family_id=? AND reference_type='game' AND reference_id LIKE 'pattern_quiz:%'`, family).Scan(&ledgerRows, &ledgerSum); err != nil {
		t.Fatal(err)
	}
	if ledgerRows != 2 || ledgerSum != 10 {
		t.Fatalf("pattern ledger: %d %d", ledgerRows, ledgerSum)
	}

	// 成绩按孩子存档：新孩子的读侧是全零、历史为空。
	w := doJSON(t, h, "POST", "/api/v1/children/", map[string]any{"name": "二娃", "avatar": "🧒", "color": "蓝"}, parentCookie(t, h), "")
	if w.Code != 200 {
		t.Fatalf("create child: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	second := childCookie(t, h, created.ID)
	if w = doJSON(t, h, "GET", "/api/v1/games/quizzes", nil, second, ""); w.Code != 200 {
		t.Fatalf("second child get: %d %s", w.Code, w.Body.String())
	}
	var secondPayload struct {
		Games   []gameView     `json:"games"`
		History []historyEntry `json:"history"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &secondPayload); err != nil {
		t.Fatal(err)
	}
	if len(secondPayload.Games) != 2 || len(secondPayload.History) != 0 {
		t.Fatalf("second child payload: %s", w.Body.String())
	}
	for _, g := range secondPayload.Games {
		if g.TodayBest != 0 || g.TodayPlays != 0 {
			t.Fatalf("second child %s: %+v", g.Game, g)
		}
	}

	// 家长端读的是同一份进度（游戏进度页的数据源）。
	parent := parentCookie(t, h)
	if w = doJSON(t, h, "GET", "/api/v1/games/quizzes", nil, parent, ""); w.Code != 200 {
		t.Fatalf("parent get: %d %s", w.Code, w.Body.String())
	}
	var parentPayload struct {
		Games []gameView `json:"games"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &parentPayload); err != nil {
		t.Fatal(err)
	}
	if len(parentPayload.Games) != 2 || parentPayload.Games[0].TodayBest != 15 || parentPayload.Games[1].TodayBest != 100 {
		t.Fatalf("parent payload: %s", w.Body.String())
	}
}
