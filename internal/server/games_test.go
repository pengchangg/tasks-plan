package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

// TestGameSaveSlotsArePerChildOpaqueAndReplaceable drives the断点存档 resource: the
// slot whitelist, the opaque state round trip, last-write-wins replace, the size
// and shape 400s, the per-child and per-family isolation, and the idempotent
// DELETE. The points/games endpoints above are untouched by any of it — a save is
// never a ledger row.
func TestGameSaveSlotsArePerChildOpaqueAndReplaceable(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	cookie := childCookie(t, h, "")

	type saveView struct {
		Game      string          `json:"game"`
		State     json.RawMessage `json:"state"`
		UpdatedAt string          `json:"updatedAt"`
	}
	saves := func(c *http.Cookie) []saveView {
		w := doJSON(t, h, "GET", "/api/v1/games/saves", nil, c, "")
		if w.Code != 200 {
			t.Fatalf("get saves: %d %s", w.Code, w.Body.String())
		}
		var payload struct {
			Saves []saveView `json:"saves"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Saves
	}

	// 空存档是 []（服务端把切片初始化为空数组），不是 null。
	if list := saves(cookie); len(list) != 0 {
		t.Fatalf("initial saves: %v", list)
	}

	board := []string{"曹张张赵", "曹张张赵", "兵卒卒兵", "兵空空兵", "孙马冯岳"}
	put := func(slot string, state any) *httptest.ResponseRecorder {
		return doJSON(t, h, "PUT", "/api/v1/games/saves/"+slot, map[string]any{"state": state}, cookie, "")
	}
	if w := put("klotski:1", map[string]any{"rows": board, "steps": 3, "history": []any{}}); w.Code != 200 {
		t.Fatalf("save klotski:1: %d %s", w.Code, w.Body.String())
	}
	// 找规律与口算各一个槽，槽名白名单里都认。
	if w := put("pattern_quiz", map[string]any{"seed": 42, "index": 4, "mistakes": 1}); w.Code != 200 {
		t.Fatalf("save pattern: %d %s", w.Code, w.Body.String())
	}
	if w := put("timed_calc", map[string]any{"tier": 2, "score": 7, "seconds": 33}); w.Code != 200 {
		t.Fatalf("save calc: %d %s", w.Code, w.Body.String())
	}
	if list := saves(cookie); len(list) != 3 {
		t.Fatalf("three slots: %d", len(list))
	}
	// state 原样回带（服务端不解释它），updatedAt 是服务端盖的。
	var restored struct {
		Rows  []string `json:"rows"`
		Steps int      `json:"steps"`
	}
	found := false
	for _, save := range saves(cookie) {
		if save.Game != "klotski:1" {
			continue
		}
		found = true
		if save.UpdatedAt == "" {
			t.Fatalf("missing updatedAt: %+v", save)
		}
		if err := json.Unmarshal(save.State, &restored); err != nil {
			t.Fatal(err)
		}
	}
	if !found || restored.Steps != 3 || len(restored.Rows) != 5 || restored.Rows[0] != board[0] {
		t.Fatalf("round trip: %+v", restored)
	}

	// PUT 是 last-write-wins：同一个槽再写一次就覆盖，不新增行。
	if w := put("klotski:1", map[string]any{"rows": board, "steps": 9, "history": []any{}}); w.Code != 200 {
		t.Fatalf("replace: %d %s", w.Code, w.Body.String())
	}
	list := saves(cookie)
	if len(list) != 3 {
		t.Fatalf("replace added a row: %d", len(list))
	}
	restored.Steps = 0
	for _, save := range list {
		if save.Game == "klotski:1" {
			if err := json.Unmarshal(save.State, &restored); err != nil {
				t.Fatal(err)
			}
		}
	}
	if restored.Steps != 9 {
		t.Fatalf("last write wins: %d", restored.Steps)
	}

	// 非法槽名（不存在的关卡、白名单外的游戏）一律 404，读也不认。
	for _, slot := range []string{"klotski:6", "klotski:0", "klotski:x", "chess"} {
		if w := put(slot, map[string]any{}); w.Code != 404 {
			t.Fatalf("bad slot %s: %d %s", slot, w.Code, w.Body.String())
		}
		if w := doJSON(t, h, "DELETE", "/api/v1/games/saves/"+slot, nil, cookie, ""); w.Code != 404 {
			t.Fatalf("delete bad slot %s: %d %s", slot, w.Code, w.Body.String())
		}
	}

	// state 缺失或超过 32 KiB 都是 400：服务端不解释它，但不会替它兜底大小。
	if w := doJSON(t, h, "PUT", "/api/v1/games/saves/klotski:1", map[string]any{}, cookie, ""); w.Code != 400 {
		t.Fatalf("missing state: %d %s", w.Code, w.Body.String())
	}
	if w := put("klotski:1", strings.Repeat("x", gameSaveMaxState+1)); w.Code != 400 {
		t.Fatalf("oversize state: %d %s", w.Code, w.Body.String())
	}
	// 未知字段是硬 400（decode 的 DisallowUnknownFields）。
	if w := doJSON(t, h, "PUT", "/api/v1/games/saves/klotski:1", map[string]any{"state": 1, "extra": 1}, cookie, ""); w.Code != 400 {
		t.Fatalf("unknown field: %d %s", w.Code, w.Body.String())
	}

	// 没选孩子就没有槽可写（家长端未选档案时也会走到这里）。
	family, _, err := s.resolvedFamily(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	state := getStateTest(t, h, cookie)
	unselected := sessionFor(t, s, family, "child", state.Children[0].ID, "")
	if w := doJSON(t, h, "GET", "/api/v1/games/saves", nil, unselected, ""); w.Code != 400 {
		t.Fatalf("unselected get: %d %s", w.Code, w.Body.String())
	}
	if w := doJSON(t, h, "PUT", "/api/v1/games/saves/klotski:1", map[string]any{"state": 1}, unselected, ""); w.Code != 400 {
		t.Fatalf("unselected put: %d %s", w.Code, w.Body.String())
	}

	// 进度按孩子隔离：第二个孩子看到的是自己的空进度。
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
	if list := saves(second); len(list) != 0 {
		t.Fatalf("second child sees saves: %d", len(list))
	}
	if w := doJSON(t, h, "PUT", "/api/v1/games/saves/klotski:1", map[string]any{"state": map[string]any{"steps": 1}}, second, ""); w.Code != 200 {
		t.Fatalf("second child save: %d %s", w.Code, w.Body.String())
	}
	// 另一个家庭看得见的是另一套：既读不到本家的槽，也动不了它。
	other := otherFamily(t, s, "OTHER", "Asia/Shanghai")
	if _, err := s.db.Exec(`INSERT INTO children(id,family_id,name,avatar,color,level,experience,points_balance,created_at) VALUES('child-other-saves',?,'Other child','⭐','#ffb547',1,0,0,?)`, other, nowText(s.now())); err != nil {
		t.Fatal(err)
	}
	foreign := sessionFor(t, s, other, "child", "child-other-saves", "child-other-saves")
	if list := saves(foreign); len(list) != 0 {
		t.Fatalf("foreign family sees saves: %d", len(list))
	}
	if w := doJSON(t, h, "PUT", "/api/v1/games/saves/klotski:1", map[string]any{"state": map[string]any{"steps": 7}}, foreign, ""); w.Code != 200 {
		t.Fatalf("foreign save: %d %s", w.Code, w.Body.String())
	}
	if w := doJSON(t, h, "DELETE", "/api/v1/games/saves/klotski:1", nil, foreign, ""); w.Code != 204 {
		t.Fatalf("foreign delete: %d %s", w.Code, w.Body.String())
	}
	if list := saves(cookie); len(list) != 3 {
		t.Fatalf("foreign writes touched the served family: %d", len(list))
	}

	// DELETE 没有行也回 204，重复调用安全。
	if w := doJSON(t, h, "DELETE", "/api/v1/games/saves/klotski:1", nil, cookie, ""); w.Code != 204 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if w := doJSON(t, h, "DELETE", "/api/v1/games/saves/klotski:1", nil, cookie, ""); w.Code != 204 {
		t.Fatalf("second delete: %d %s", w.Code, w.Body.String())
	}
	if list := saves(cookie); len(list) != 2 {
		t.Fatalf("after delete: %d", len(list))
	}
}

// TestGameCostsAreParentOnlyChargedOnceAndRefuseToOverdraw locks the game
// billing rules: the two prices default to free and only the parent can set them
// (0…500), every new round/hint charges exactly once per Idempotency-Key and
// writes one spent ledger row, a repeat with the same key replays instead of
// charging twice, and an empty wallet answers 409 without going negative (or
// leaving a claim behind).
func TestGameCostsAreParentOnlyChargedOnceAndRefuseToOverdraw(t *testing.T) {
	s := testServer(t)
	h := s.Handler()
	cookie := childCookie(t, h, "")
	state := getStateTest(t, h, cookie)
	childID := state.Children[0].ID
	family, _, err := s.resolvedFamily(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	spent := func() int {
		var n int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM point_ledger WHERE family_id=? AND entry_type='spent'`, family).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	balance := func() int {
		var n int
		if err := s.db.QueryRow(`SELECT points_balance FROM children WHERE id=?`, childID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	charge := func(path, game string, key string) *httptest.ResponseRecorder {
		return doJSON(t, h, "POST", "/api/v1/games/"+path, map[string]string{"game": game}, cookie, key)
	}

	// 默认免费：不写台账、不动余额。
	if state.GameCosts.PlayCost != 0 || state.GameCosts.HintCost != 0 {
		t.Fatalf("fresh costs: %+v", state.GameCosts)
	}
	before := balance()
	if w := charge("play", "timed_calc", "free-play"); w.Code != 200 || !strings.Contains(w.Body.String(), `"cost":0`) {
		t.Fatalf("free play: %d %s", w.Code, w.Body.String())
	}
	if balance() != before || spent() != 0 {
		t.Fatalf("free play moved money: %d %d", balance(), spent())
	}

	// 只有家长能定价，范围 0…500。
	parent := parentCookie(t, h)
	if w := doJSON(t, h, "PUT", "/api/v1/games/costs", map[string]int{"playCost": 5, "hintCost": 2}, parent, ""); w.Code != 200 {
		t.Fatalf("save costs: %d %s", w.Code, w.Body.String())
	}
	if got := getStateTest(t, h, cookie).GameCosts; got.PlayCost != 5 || got.HintCost != 2 {
		t.Fatalf("state costs: %+v", got)
	}
	if w := doJSON(t, h, "PUT", "/api/v1/games/costs", map[string]int{"playCost": 5, "hintCost": 2}, cookie, ""); w.Code != 403 {
		t.Fatalf("child set costs: %d %s", w.Code, w.Body.String())
	}
	if w := doJSON(t, h, "PUT", "/api/v1/games/costs", map[string]int{"playCost": -1, "hintCost": 2}, parent, ""); w.Code != 400 {
		t.Fatalf("negative cost: %d %s", w.Code, w.Body.String())
	}
	if w := doJSON(t, h, "PUT", "/api/v1/games/costs", map[string]int{"playCost": 5, "hintCost": 501}, parent, ""); w.Code != 400 {
		t.Fatalf("oversized cost: %d %s", w.Code, w.Body.String())
	}

	// 一次游玩扣一次，同键重发只回放、不再扣。
	if w := charge("play", "timed_calc", "round-1"); w.Code != 200 || !strings.Contains(w.Body.String(), `"cost":5`) {
		t.Fatalf("play charge: %d %s", w.Code, w.Body.String())
	}
	if balance() != before-5 || spent() != 1 {
		t.Fatalf("play charge: %d %d", balance(), spent())
	}
	var reference string
	if err := s.db.QueryRow(`SELECT reference_type||':'||entry_type FROM point_ledger WHERE family_id=? AND entry_type='spent'`, family).Scan(&reference); err != nil {
		t.Fatal(err)
	}
	if reference != "game:spent" {
		t.Fatalf("ledger row: %s", reference)
	}
	if w := charge("play", "timed_calc", "round-1"); w.Code != 200 || !strings.Contains(w.Body.String(), `"replayed":true`) {
		t.Fatalf("play replay: %d %s", w.Code, w.Body.String())
	}
	if balance() != before-5 || spent() != 1 {
		t.Fatalf("replay charged twice: %d %d", balance(), spent())
	}

	// 提示只对华容道有价；槽名必须在存档白名单里；必须带幂等键。
	if w := charge("hint", "klotski:2", "hint-1"); w.Code != 200 || !strings.Contains(w.Body.String(), `"cost":2`) {
		t.Fatalf("hint charge: %d %s", w.Code, w.Body.String())
	}
	if balance() != before-7 || spent() != 2 {
		t.Fatalf("hint charge: %d %d", balance(), spent())
	}
	if w := charge("hint", "timed_calc", "hint-2"); w.Code != 404 {
		t.Fatalf("quiz hint: %d %s", w.Code, w.Body.String())
	}
	if w := charge("play", "klotski:9", "round-2"); w.Code != 404 {
		t.Fatalf("unknown slot: %d %s", w.Code, w.Body.String())
	}
	if w := charge("play", "timed_calc", ""); w.Code != 400 || !strings.Contains(w.Body.String(), "idempotency_required") {
		t.Fatalf("missing key: %d %s", w.Code, w.Body.String())
	}

	// 没有余额就不能开局：409、余额不为负、台账不多、幂等占位随回滚消失。
	if _, err := s.db.Exec(`UPDATE children SET points_balance=0 WHERE id=?`, childID); err != nil {
		t.Fatal(err)
	}
	if w := charge("play", "timed_calc", "round-poor"); w.Code != 409 || !strings.Contains(w.Body.String(), "insufficient_points") {
		t.Fatalf("overdraw: %d %s", w.Code, w.Body.String())
	}
	if balance() != 0 || spent() != 2 {
		t.Fatalf("overdraw wrote: %d %d", balance(), spent())
	}
	if _, err := s.db.Exec(`UPDATE children SET points_balance=5 WHERE id=?`, childID); err != nil {
		t.Fatal(err)
	}
	if w := charge("play", "timed_calc", "round-poor"); w.Code != 200 {
		t.Fatalf("retry after topping up: %d %s", w.Code, w.Body.String())
	}

	// 没选孩子时不能扣（家长端未选档案也会走到这里）。
	unselected := sessionFor(t, s, family, "child", childID, "")
	if w := doJSON(t, h, "POST", "/api/v1/games/play", map[string]string{"game": "timed_calc"}, unselected, "round-unselected"); w.Code != 400 {
		t.Fatalf("unselected charge: %d %s", w.Code, w.Body.String())
	}

	// 另一个家庭有自己的一套价格与钱包：默认免费，本家的账不受影响。
	other := otherFamily(t, s, "OTHER", "Asia/Shanghai")
	if _, err := s.db.Exec(`INSERT INTO children(id,family_id,name,avatar,color,level,experience,points_balance,created_at) VALUES('child-other-costs',?,'Other child','⭐','#ffb547',1,0,50,?)`, other, nowText(s.now())); err != nil {
		t.Fatal(err)
	}
	foreign := sessionFor(t, s, other, "child", "child-other-costs", "child-other-costs")
	if w := doJSON(t, h, "POST", "/api/v1/games/play", map[string]string{"game": "timed_calc"}, foreign, "round-foreign"); w.Code != 200 {
		t.Fatalf("foreign charge: %d %s", w.Code, w.Body.String())
	}
	var foreignBalance int
	if err := s.db.QueryRow(`SELECT points_balance FROM children WHERE id='child-other-costs'`).Scan(&foreignBalance); err != nil {
		t.Fatal(err)
	}
	if foreignBalance != 50 || balance() != 0 || spent() != 3 {
		t.Fatalf("foreign charge leaked: %d %d %d", foreignBalance, balance(), spent())
	}
}
