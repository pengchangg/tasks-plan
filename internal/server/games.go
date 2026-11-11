package server

import (
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"sync"

	"github.com/go-chi/chi/v5"
)

// 华容道：内置 5 关经典布局，按序解锁，首次通关每关记 30 积分。布局只存服务端一份，
// 前端从 GET /games/klotski 拿 rows，不复制布局数据。行是权威数据，逐格验算过：
// 每关 4×5=20 格，曹操 2×2（C×4）+ 四竖将 1×2（A/B/D/E 各两格）+ 关羽 2×1（G×2）
// + 四卒 1×1（p/q/r/s）= 18 格 + 2 空格，无重叠。
type klotskiLevel struct {
	Name string
	Rows [5]string
}

var klotskiLevels = map[int]klotskiLevel{
	1: {Name: "横刀立马", Rows: [5]string{"ACCB", "ACCB", "DGGE", "D..E", "pqrs"}},
	2: {Name: "指挥若定", Rows: [5]string{"ACCB", "ACCB", "pDEr", "qDEs", "GG.."}},
	3: {Name: "兵分三路", Rows: [5]string{"CCAB", "CCAB", "Dp.E", "DGGE", "qr.s"}},
	4: {Name: "重重封锁", Rows: [5]string{"ApqB", "ACCB", "DCCE", "D..E", "rGGs"}},
	5: {Name: "兵贵神速", Rows: [5]string{"CCAB", "CCAB", "GG..", "pqDE", "rsDE"}},
}

const (
	klotskiMaxLevel = 5
	klotskiReward   = 30
	// klotskiMaxMoves 是完成接口接受的上限：真实通关用不了这么多步，超出的一律按
	// 非法请求拦下。下限不设静态值——每关的最低步数由 klotskiShortest 现场算出
	// （BFS 毫秒级），第 4 关最少 79 步，写死 81 会把最省力的关也拦掉。
	klotskiMaxMoves = 10000
)

// klotskiFloors 是每关完成接口接受的步数下限 = 该关布局的最短解（BFS 现场算，进程
// 里只算一次）。布局是写死的常量，算出来的下限也是常量，只是不想让这两处数字漂移。
var klotskiFloors = sync.OnceValue(func() map[int]int {
	floors := make(map[int]int, klotskiMaxLevel)
	for level := 1; level <= klotskiMaxLevel; level++ {
		floors[level] = klotskiShortest(klotskiLevels[level].Rows)
	}
	return floors
})

// klotskiLevelView 是一关在接口里的样子：布局 + 这个孩子的解锁/通关状态。
// MinMoves 是完成接口同一个 BFS 算出的该关最少步数，界面用它标「最少 N 步」，
// 与提示系统的客户端 BFS 结果同源可核对。
type klotskiLevelView struct {
	Level     int       `json:"level"`
	Name      string    `json:"name"`
	Rows      [5]string `json:"rows"`
	MinMoves  int       `json:"minMoves"`
	Unlocked  bool      `json:"unlocked"`
	Completed bool      `json:"completed"`
	BestMoves int       `json:"bestMoves"`
}

// klotskiPayload 是 GET /games/klotski 的响应：全部关卡按序 + 通关数。
type klotskiPayload struct {
	Levels    []klotskiLevelView `json:"levels"`
	Completed int                `json:"completed"`
}

// getKlotski 返回 5 关布局与该孩子的进度，孩子端与家长端都能读。解锁规则：第 1 关
// 常开，其余要前一关已通关。池只有一个连接，进度查询必须先读完关闭再拼装响应。
func (s *Server) getKlotski(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT level,best_moves FROM klotski_progress WHERE family_id=? AND child_id=? ORDER BY level`, x.FamilyID, x.SelectedChildID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	best := map[int]int{}
	for rows.Next() {
		var level, moves int
		if err = rows.Scan(&level, &moves); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		best[level] = moves
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		s.internalError(w, r, err)
		return
	}
	rows.Close()
	floors := klotskiFloors()
	out := klotskiPayload{Levels: make([]klotskiLevelView, 0, klotskiMaxLevel)}
	for level := 1; level <= klotskiMaxLevel; level++ {
		levelRow := klotskiLevels[level]
		view := klotskiLevelView{
			Level:    level,
			Name:     levelRow.Name,
			Rows:     levelRow.Rows,
			MinMoves: floors[level],
			Unlocked: level == 1 || best[level-1] > 0,
		}
		if moves, ok := best[level]; ok {
			view.Completed = true
			view.BestMoves = moves
			out.Completed++
		}
		out.Levels = append(out.Levels, view)
	}
	writeJSON(w, http.StatusOK, out)
}

// completeKlotski 记录一次通关：首次通关才记 30 积分（PRIMARY KEY + INSERT OR
// IGNORE 保证每关只记一次，天然幂等，所以不需要 Idempotency-Key，理由同
// setHomeworkDone）；重复通关只在步数更少时刷新 best_moves。任何角色都能调，
// 但只写当前选中孩子名下的行（同 /homework/{id}/done 的 any-actor 语义）。
func (s *Server) completeKlotski(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	level, err := strconv.Atoi(chi.URLParam(r, "level"))
	if _, ok := klotskiLevels[level]; !ok {
		problem(w, http.StatusNotFound, "not_found", "klotski level not found")
		return
	}
	var in struct {
		Moves int `json:"moves"`
	}
	// 服务端信任客户端上报的步数（家庭内应用，同作业勾选的信任级别），只做区间校验：
	// 少于该关最短解的步数不可能是真打出来的，超过上限的一律按非法请求拦下。
	if decode(r, &in) != nil || in.Moves < klotskiFloors()[level] || in.Moves > klotskiMaxMoves {
		problem(w, http.StatusBadRequest, "invalid_request", "moves out of range")
		return
	}
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	// 按序解锁：前一关没通关就完成本关，等于跳过关卡领奖。
	if level > 1 {
		var prev int
		err = s.db.QueryRowContext(r.Context(), `SELECT 1 FROM klotski_progress WHERE family_id=? AND child_id=? AND level=?`, x.FamilyID, x.SelectedChildID, level-1).Scan(&prev)
		if errors.Is(err, sql.ErrNoRows) {
			problem(w, http.StatusConflict, "invalid_state", "previous level not completed")
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	now := nowText(s.now())
	res, err := tx.Exec(`INSERT OR IGNORE INTO klotski_progress(family_id,child_id,level,best_moves,completed_at) VALUES(?,?,?,?,?)`, x.FamilyID, x.SelectedChildID, level, in.Moves, now)
	var changed int64
	if err == nil {
		changed, err = res.RowsAffected()
	}
	awarded := 0
	if err == nil && changed == 1 {
		// 首次通关：记 30 积分。成长值 30/5=6，等级按新经验重算，公式与 awardPoints
		// 的手动奖励分支逐字一致。
		awarded = klotskiReward
		growth := klotskiReward / 5
		if growth < 1 {
			growth = 1
		}
		refID := "klotski:" + strconv.Itoa(level)
		if err == nil {
			_, err = tx.Exec(`UPDATE children SET points_balance=points_balance+?,experience=experience+?,level=1+CAST((experience+?)/100 AS INTEGER) WHERE id=? AND family_id=?`, klotskiReward, growth, growth, x.SelectedChildID, x.FamilyID)
		}
		// 这里是普通 INSERT：唯一键 (family_id,reference_type,reference_id) 冲突只可能
		// 来自脏数据（进度行被删而台账还在），此时整个事务回滚、报内部错误，宁可丢一次
		// 领奖也不能记出两笔。
		if err == nil {
			_, err = tx.Exec(`INSERT INTO point_ledger(id,family_id,child_id,amount,entry_type,reference_type,reference_id,description,created_at) VALUES(?,?,?,?,'earned','game',?,?,?)`, id("led"), x.FamilyID, x.SelectedChildID, klotskiReward, refID, "通关华容道："+klotskiLevels[level].Name, now)
		}
	} else if err == nil {
		// 已通关：只在步数更少时刷新纪录。
		_, err = tx.Exec(`UPDATE klotski_progress SET best_moves=? WHERE family_id=? AND child_id=? AND level=? AND best_moves>?`, in.Moves, x.FamilyID, x.SelectedChildID, level, in.Moves)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": "klotski:" + strconv.Itoa(level), "awarded": awarded})
}

// klotskiShortest 从给定布局出发做广度优先搜索，求曹操到达底行正中
// （rows[3][1..2] 与 rows[4][1..2] 全为 C）所需的最少滑动次数（棋子每滑一格记一步），
// 无解回 -1。四个竖将形状相同、四个卒形状相同，编码时按同形互换归一（排序各自的
// 落点）：滑动合法性只看形状，商图里的路径总能落到真实棋子上，可解性与最短步数
// 都等价，而状态空间从千万级回到约 6.5 万，毫秒级完成。常设测试用它守住五关布局
// 全部可解，完成接口用它当场定每关的步数下限。
func klotskiShortest(rows [5]string) int {
	// 槽位顺序：C、四个竖将、G、四个卒；同组槽位互换只是标签换名。
	start := [10]int{}
	slot := map[byte]int{'C': 0, 'A': 1, 'B': 2, 'D': 3, 'E': 4, 'G': 5, 'p': 6, 'q': 7, 'r': 8, 's': 9}
	var filled [10]bool
	for r := range 5 {
		for c := range 4 {
			i, ok := slot[rows[r][c]]
			// 行主序第一次撞上这个字符就是它的左上锚点（后面的格子是同一子的其余格）。
			if ok && !filled[i] {
				start[i] = r*4 + c
				filled[i] = true
			}
		}
	}
	// 各槽位的形状（相对左上锚点的偏移）。
	shape := [10][4][2]int{
		{{0, 0}, {0, 1}, {1, 0}, {1, 1}},
		{{0, 0}, {1, 0}}, {{0, 0}, {1, 0}}, {{0, 0}, {1, 0}}, {{0, 0}, {1, 0}},
		{{0, 0}, {0, 1}},
		{{0, 0}}, {{0, 0}}, {{0, 0}}, {{0, 0}},
	}
	size := [10]int{4, 2, 2, 2, 2, 2, 1, 1, 1, 1}
	// encode 生成归一后的键：竖将（1..4）与卒（6..9）的落点各自排序。
	encode := func(state [10]int) [10]byte {
		var key [10]byte
		for i, pos := range state {
			key[i] = byte(pos)
		}
		slices.Sort(key[1:5])
		slices.Sort(key[6:10])
		return key
	}
	dirs := [4][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}}
	type node struct {
		state [10]int
		dist  int
	}
	seen := map[[10]byte]bool{encode(start): true}
	queue := []node{{state: start}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur.state[0] == 3*4+1 {
			return cur.dist
		}
		// occupied 铺一张 5×4 的归属图：-1 空格，否则槽位号。
		var grid [20]int
		for i := range grid {
			grid[i] = -1
		}
		for i, pos := range cur.state {
			for k := range size[i] {
				grid[(pos/4+shape[i][k][0])*4+pos%4+shape[i][k][1]] = i
			}
		}
		for i := range cur.state {
			for _, d := range dirs {
				nr, nc := cur.state[i]/4+d[0], cur.state[i]%4+d[1]
				if nr < 0 || nr > 4 || nc < 0 || nc > 3 {
					continue
				}
				ok := true
				for k := range size[i] {
					rr, cc := nr+shape[i][k][0], nc+shape[i][k][1]
					if rr > 4 || cc > 3 {
						ok = false
						break
					}
					if cell := grid[rr*4+cc]; cell != i && cell != -1 {
						ok = false
						break
					}
				}
				if !ok {
					continue
				}
				next := cur.state
				next[i] = nr*4 + nc
				key := encode(next)
				if seen[key] {
					continue
				}
				seen[key] = true
				queue = append(queue, node{state: next, dist: cur.dist + 1})
			}
		}
	}
	return -1
}
