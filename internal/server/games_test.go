package server

import (
	"context"
	"encoding/json"
	"testing"
)

// TestKlotskiLevelsAreSolvable BFS-verifyies every built-in layout: a shipped
// level the child can never finish is a broken reward promise, not a challenge.
// The minimum also pins the completion endpoint's moves floor, so a level with no
// solution (−1) must fail the run, not silently accept any move count.
func TestKlotskiLevelsAreSolvable(t *testing.T) {
	for level := 1; level <= klotskiMaxLevel; level++ {
		if shortest := klotskiShortest(klotskiLevels[level].Rows); shortest < 0 {
			t.Fatalf("level %d unsolvable", level)
		}
	}
}

// TestKlotskiProgressIsPerChildRewardsOnceAndGatesTheNextLevel drives the whole
// game surface: the read payload shape, the moves range, the once-only 30-point
// credit with its ledger row, the best-moves refresh on replay, the sequential
// unlock gate, the unknown level, and per-child isolation.
func TestKlotskiProgressIsPerChildRewardsOnceAndGatesTheNextLevel(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	cookie := childCookie(t, h, "")

	type levelView struct {
		Level     int      `json:"level"`
		Name      string   `json:"name"`
		Rows      []string `json:"rows"`
		MinMoves  int      `json:"minMoves"`
		Unlocked  bool     `json:"unlocked"`
		Completed bool     `json:"completed"`
		BestMoves int      `json:"bestMoves"`
	}
	getPayload := func() (int, []levelView) {
		w := doJSON(t, h, "GET", "/api/v1/games/klotski", nil, cookie, "")
		if w.Code != 200 {
			t.Fatalf("get klotski: %d %s", w.Code, w.Body.String())
		}
		var payload struct {
			Levels    []levelView `json:"levels"`
			Completed int         `json:"completed"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Completed, payload.Levels
	}

	completed, levels := getPayload()
	if len(levels) != klotskiMaxLevel || completed != 0 {
		t.Fatalf("initial payload: %d %d", len(levels), completed)
	}
	for i, lv := range levels {
		if lv.Level != i+1 || lv.Name != klotskiLevels[i+1].Name {
			t.Fatalf("level %d shape: %+v", i+1, lv)
		}
		if lv.Unlocked != (i == 0) || lv.Completed || lv.BestMoves != 0 {
			t.Fatalf("level %d gate: %+v", i+1, lv)
		}
		// minMoves 下发的是完成接口同一个 BFS 的下限，未通关也带——界面用它标
		// 「最少 N 步」，并与客户端提示 BFS 的结果核对。
		if lv.MinMoves != klotskiFloors()[i+1] || lv.MinMoves <= 0 {
			t.Fatalf("level %d min moves: %d want %d", i+1, lv.MinMoves, klotskiFloors()[i+1])
		}
	}

	// 第 1 关最短解 118 步，80 步不可能是真打出来的，一律 400。
	if w := doJSON(t, h, "POST", "/api/v1/games/klotski/1/complete", map[string]int{"moves": 80}, cookie, ""); w.Code != 400 {
		t.Fatalf("moves below floor: %d %s", w.Code, w.Body.String())
	}
	if w := doJSON(t, h, "POST", "/api/v1/games/klotski/1/complete", map[string]int{"moves": 20000}, cookie, ""); w.Code != 400 {
		t.Fatalf("moves above ceiling: %d %s", w.Code, w.Body.String())
	}
	// 跳关：第 2 关必须等第 1 关通关。
	if w := doJSON(t, h, "POST", "/api/v1/games/klotski/2/complete", map[string]int{"moves": 120}, cookie, ""); w.Code != 409 {
		t.Fatalf("skip level: %d %s", w.Code, w.Body.String())
	}
	// 不存在的关卡。
	if w := doJSON(t, h, "POST", "/api/v1/games/klotski/6/complete", map[string]int{"moves": 120}, cookie, ""); w.Code != 404 {
		t.Fatalf("unknown level: %d %s", w.Code, w.Body.String())
	}

	before := getStateTest(t, h, cookie)
	balanceBefore, experienceBefore, levelBefore := before.Children[0].PointsBalance, before.Children[0].Experience, before.Children[0].Level

	complete := func(path string, moves int) int {
		w := doJSON(t, h, "POST", path, map[string]int{"moves": moves}, cookie, "")
		if w.Code != 200 {
			t.Fatalf("complete %s: %d %s", path, w.Code, w.Body.String())
		}
		var out struct {
			ID      string `json:"id"`
			Awarded int    `json:"awarded"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.Awarded
	}
	if awarded := complete("/api/v1/games/klotski/1/complete", 120); awarded != klotskiReward {
		t.Fatalf("first clear: %d", awarded)
	}

	after := getStateTest(t, h, cookie)
	if after.Children[0].PointsBalance != balanceBefore+klotskiReward {
		t.Fatalf("balance: %d -> %d", balanceBefore, after.Children[0].PointsBalance)
	}
	if after.Children[0].Experience != experienceBefore+klotskiReward/5 {
		t.Fatalf("experience: %v -> %v", experienceBefore, after.Children[0].Experience)
	}
	if after.Children[0].Level < levelBefore {
		t.Fatalf("level dropped: %v -> %v", levelBefore, after.Children[0].Level)
	}
	var gameRows int
	family, _, err := s.resolvedFamily(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRow(`SELECT COUNT(*) FROM point_ledger WHERE family_id=? AND reference_type='game' AND reference_id='klotski:1' AND amount=30`, family).Scan(&gameRows); err != nil {
		t.Fatal(err)
	}
	if gameRows != 1 {
		t.Fatalf("game ledger rows: %d", gameRows)
	}

	// 重放只刷纪录，不再记分。
	if awarded := complete("/api/v1/games/klotski/1/complete", 200); awarded != 0 {
		t.Fatalf("replay award: %d", awarded)
	}
	_, levels = getPayload()
	if levels[0].BestMoves != 120 {
		t.Fatalf("best after worse replay: %d", levels[0].BestMoves)
	}
	if awarded := complete("/api/v1/games/klotski/1/complete", 118); awarded != 0 {
		t.Fatalf("better replay award: %d", awarded)
	}
	_, levels = getPayload()
	if levels[0].BestMoves != 118 || !levels[0].Completed {
		t.Fatalf("best after better replay: %+v", levels[0])
	}

	// 通关第 1 关解锁第 2 关，首通再记一次 30。
	if awarded := complete("/api/v1/games/klotski/2/complete", 100); awarded != klotskiReward {
		t.Fatalf("level 2 first clear: %d", awarded)
	}
	completed, levels = getPayload()
	if completed != 2 || !levels[1].Completed || !levels[2].Unlocked {
		t.Fatalf("after two clears: %d %+v", completed, levels)
	}

	// 进度按孩子存档：新建第二个孩子切过去，看到的仍是只有第 1 关解锁的空白进度。
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
	w = doJSON(t, h, "GET", "/api/v1/games/klotski", nil, second, "")
	if w.Code != 200 {
		t.Fatalf("second child get: %d %s", w.Code, w.Body.String())
	}
	var secondPayload struct {
		Levels    []levelView `json:"levels"`
		Completed int         `json:"completed"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &secondPayload); err != nil {
		t.Fatal(err)
	}
	if secondPayload.Completed != 0 || !secondPayload.Levels[0].Unlocked || secondPayload.Levels[0].Completed {
		t.Fatalf("second child progress: %s", w.Body.String())
	}
}
