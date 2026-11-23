package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

// 游戏断点存档：华容道的盘面、口算的剩余秒数、找规律的题号都按孩子存在
// game_saves 里，离开页面再回来接着玩。state 对服务端是不透明 JSON——只校验大小
// 与合法性，形状由写入它的那一端负责（信任级别同上报的步数与分数）。PUT 是
// last-write-wins 的 upsert，重发同一个局面不会有副作用，所以不要求 Idempotency-Key；
// DELETE 无论有没有行都回 204，重复调用一样安全。存档不设过期：断点多旧都能续，
// 「重新开始本关 / 重新开一局」永远在那一屏上，孩子随时能丢掉它。
const gameSaveMaxState = 32 * 1024

type gameSaveEntry struct {
	Game      string          `json:"game"`
	State     json.RawMessage `json:"state"`
	UpdatedAt string          `json:"updatedAt"`
}

// validGameSaveKey 是槽名白名单：两个题类游戏各一个槽，华容道每关一个。
func validGameSaveKey(key string) bool {
	if key == quizCalc || key == quizPattern {
		return true
	}
	rest, ok := strings.CutPrefix(key, "klotski:")
	if !ok {
		return false
	}
	level, err := strconv.Atoi(rest)
	if err != nil {
		return false
	}
	_, ok = klotskiLevels[level]
	return ok
}

// getGameSaves 返回当前孩子在玩的断点，孩子端与家长端都能读（同 getKlotski 的
// any-actor 语义）。池只有一个连接，读完必须先关闭再写响应。
func (s *Server) getGameSaves(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT game,state,updated_at FROM game_saves WHERE family_id=? AND child_id=? ORDER BY game`, x.FamilyID, x.SelectedChildID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	saves := make([]gameSaveEntry, 0, klotskiMaxLevel+2)
	for rows.Next() {
		var e gameSaveEntry
		var state string
		if err = rows.Scan(&e.Game, &state, &e.UpdatedAt); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		// TEXT 扫进 string 再转 RawMessage：database/sql 不接受直接扫 []byte。
		e.State = json.RawMessage(state)
		saves = append(saves, e)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		s.internalError(w, r, err)
		return
	}
	rows.Close()
	writeJSON(w, http.StatusOK, map[string]any{"saves": saves})
}

// saveGameState 覆盖某个槽的断点。单条 upsert，不需要事务：同一局面的重发只是
// 再写一遍同样的值。
func (s *Server) saveGameState(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	key := chi.URLParam(r, "game")
	if !validGameSaveKey(key) {
		problem(w, http.StatusNotFound, "not_found", "game save slot not found")
		return
	}
	var in struct {
		State json.RawMessage `json:"state"`
	}
	if decode(r, &in) != nil || len(in.State) == 0 || len(in.State) > gameSaveMaxState || !json.Valid(in.State) {
		problem(w, http.StatusBadRequest, "invalid_request", "state must be JSON under 32 KiB")
		return
	}
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	_, err := s.db.ExecContext(r.Context(), `INSERT INTO game_saves(family_id,child_id,game,state,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(family_id,child_id,game) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`, x.FamilyID, x.SelectedChildID, key, string(in.State), nowText(s.now()))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": key})
}

// deleteGameState 清掉某个槽：通关、交卷、重新开始都走这里。没有行也回 204。
func (s *Server) deleteGameState(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	key := chi.URLParam(r, "game")
	if !validGameSaveKey(key) {
		problem(w, http.StatusNotFound, "not_found", "game save slot not found")
		return
	}
	if x.SelectedChildID == "" {
		problem(w, http.StatusBadRequest, "invalid_request", "no child selected")
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM game_saves WHERE family_id=? AND child_id=? AND game=?`, x.FamilyID, x.SelectedChildID, key); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
