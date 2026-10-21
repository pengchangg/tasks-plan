package server

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/go-chi/chi/v5"
	// imaging 代为注册 jpeg/png/gif/bmp/tiff 的解码器，webp 必须自己登记。
	_ "golang.org/x/image/webp"
)

const (
	homeworkMaxEdge     = 2560
	homeworkJPEGQuality = 85
)

// 学科固定 10 项，与 src/App.tsx 的 homeworkSubjects 一一对应；改一处必须改另一处。
var homeworkSubjects = []string{"语文", "数学", "英语", "科学", "道德与法治", "音乐", "美术", "体育", "劳动", "其他"}

func validHomeworkSubject(v string) bool {
	for _, subject := range homeworkSubjects {
		if subject == v {
			return true
		}
	}
	return false
}

// validDateValue 只接受补零的 YYYY-MM-DD（time.Parse 会放过 2026-1-1）。
func validDateValue(v string) bool {
	t, err := time.Parse("2006-01-02", v)
	return err == nil && t.Format("2006-01-02") == v
}

// Homework 是一条作业。媒体复用 Attachment：前端可以直接把它交给现有的媒体渲染。
type Homework struct {
	ID          string       `json:"id"`
	Date        string       `json:"date"`
	Subject     string       `json:"subject"`
	Description string       `json:"description"`
	CreatedAt   string       `json:"createdAt"`
	Media       []Attachment `json:"media"`
}

// HomeworkDay 是某个家庭本地日期的全部作业，按录入顺序。
type HomeworkDay struct {
	Date  string     `json:"date"`
	Items []Homework `json:"items"`
}

// getHomework 读一天的作业，孩子端与家长端都能用；date 缺省是家庭本地的今天。
func (s *Server) getHomework(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	loc, err := s.familyLocation(r.Context(), x.FamilyID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	if date == "" {
		date = s.now().In(loc).Format("2006-01-02")
	}
	if !validDateValue(date) {
		problem(w, 400, "invalid_request", "date must be YYYY-MM-DD")
		return
	}
	out, err := s.homeworkDay(r.Context(), x.FamilyID, date)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, out)
}

// homeworkDay 读一天的作业及其媒体。池只有一个连接，所以外层 Rows 必须读完关闭
// 之后才能查每条作业的媒体。
func (s *Server) homeworkDay(ctx context.Context, family, date string) (HomeworkDay, error) {
	out := HomeworkDay{Date: date, Items: []Homework{}}
	// created_at 是裁剪过尾零的 RFC3339Nano，同一秒内的字典序不可靠，rowid 才是录入顺序。
	rows, err := s.db.QueryContext(ctx, `SELECT id,date,subject,description,created_at FROM homework WHERE family_id=? AND date=? ORDER BY created_at,rowid`, family, date)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		item := Homework{Media: []Attachment{}}
		if err = rows.Scan(&item.ID, &item.Date, &item.Subject, &item.Description, &item.CreatedAt); err != nil {
			rows.Close()
			return out, err
		}
		out.Items = append(out.Items, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	for i := range out.Items {
		if out.Items[i].Media, err = s.homeworkMediaFor(ctx, family, out.Items[i].ID); err != nil {
			return out, err
		}
	}
	return out, nil
}

// homeworkMediaFor 按 sort 升序取一条作业的媒体（sort 由写入端从 0 起递增）。
func (s *Server) homeworkMediaFor(ctx context.Context, family, homeworkID string) ([]Attachment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,original_name,media_type FROM homework_media WHERE family_id=? AND homework_id=? ORDER BY sort`, family, homeworkID)
	if err != nil {
		return nil, err
	}
	media := []Attachment{}
	for rows.Next() {
		var a Attachment
		if err = rows.Scan(&a.ID, &a.Name, &a.Type); err != nil {
			rows.Close()
			return nil, err
		}
		a.URL = "/api/v1/media/" + a.ID
		media = append(media, a)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return media, nil
}

type homeworkCandidate struct {
	h                   *multipart.FileHeader
	kind, mimeType, ext string
}

// videoType 只认 ISO-BMFF（按 ftyp brand 区分 mp4/mov/m4v）与 webm。
func videoType(header []byte, size int64) (mimeType, ext string, ok bool) {
	if isMP4(header, size) {
		switch string(header[8:12]) {
		case "qt  ", "M4V ", "m4v ": // QuickTime / Apple M4V，iPhone 录的视频
			return "video/quicktime", ".mov", true
		}
		return "video/mp4", ".mp4", true
	}
	if isWebM(header) {
		return "video/webm", ".webm", true
	}
	return "", "", false
}

// inspectHomeworkUpload 比 inspectUpload 放宽两条：图片多收 gif/bmp（入库前统一转 JPEG），
// 视频多收 mov/m4v。既有证据上传路径保持原样（只有 jpeg/png/webp + mp4/webm）。
func inspectHomeworkUpload(h *multipart.FileHeader) (kind, mimeType, storageExt string, ok bool) {
	if h.Size <= 0 {
		return "", "", "", false
	}
	file, err := h.Open()
	if err != nil {
		return "", "", "", false
	}
	defer file.Close()
	header := make([]byte, 512)
	n, err := io.ReadFull(file, header)
	if err != nil && err != io.ErrUnexpectedEOF {
		return "", "", "", false
	}
	switch http.DetectContentType(header[:n]) {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp":
		return "image", "image/jpeg", ".jpg", true
	}
	if mimeType, storageExt, ok = videoType(header[:n], h.Size); ok {
		return "video", mimeType, storageExt, true
	}
	return "", "", "", false
}

// storeHomeworkImage 把上传的图片解码、按 EXIF 方向摆正、必要缩到最长边 2560（只缩不放）、
// 透明底铺白，最后写成 JPEG q85 落盘，返回落盘后的字节数。
func (s *Server) storeHomeworkImage(src io.Reader, storage string) (int64, error) {
	img, err := imaging.Decode(src, imaging.AutoOrientation(true))
	if err != nil {
		return 0, err
	}
	// Fit 在源图已经小于上限时直接 Clone，所以这里天然是「只缩不放」。
	img = imaging.Fit(img, homeworkMaxEdge, homeworkMaxEdge, imaging.Lanczos)
	canvas := image.NewRGBA(img.Bounds())
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(canvas, canvas.Bounds(), img, img.Bounds().Min, draw.Over)
	path := filepath.Join(s.mediaDir, storage)
	dst, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	out := bufio.NewWriter(dst)
	if err = imaging.Encode(out, canvas, imaging.JPEG, imaging.JPEGQuality(homeworkJPEGQuality)); err == nil {
		err = out.Flush()
	}
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(path)
		return 0, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// storeHomeworkVideo 原样落盘、不转码，返回落盘后的字节数。
func (s *Server) storeHomeworkVideo(src io.Reader, storage string) (int64, error) {
	path := filepath.Join(s.mediaDir, storage)
	dst, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(dst, src)
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(path)
		return 0, err
	}
	return n, nil
}

// homeworkMaxUpload 是单次作业上传的总预算，与任务提交、心愿完成一致：媒体目录和
// SQLite 文件在同一个卷上，一次不设上限的写入就能把整个部署写满。
const homeworkMaxUpload = 100 << 20

// saveHomework 是 POST /homework/（新建）与 PUT /homework/{id}（编辑）共用的家长端写入路径。
// 跳过不支持格式的宽容态度不影响上限：张数与总量都按提交路径的预算卡。
func (s *Server) saveHomework(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	ctx := r.Context()
	r.Body = http.MaxBytesReader(w, r.Body, homeworkMaxUpload+(1<<20))
	if err := r.ParseMultipartForm(homeworkMaxUpload); err != nil {
		problem(w, 413, "upload_too_large", "homework upload is too large")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	files := r.MultipartForm.File["files"]
	if len(files) > 6 {
		problem(w, 400, "too_many_files", "at most 6 files per homework")
		return
	}
	var uploadTotal int64
	for _, f := range files {
		uploadTotal += f.Size
	}
	if uploadTotal > homeworkMaxUpload {
		problem(w, 413, "upload_too_large", "homework upload is too large")
		return
	}
	date := strings.TrimSpace(r.FormValue("date"))
	subject := strings.TrimSpace(r.FormValue("subject"))
	description := strings.TrimSpace(r.FormValue("description"))
	if !validDateValue(date) {
		problem(w, 400, "invalid_request", "date must be YYYY-MM-DD")
		return
	}
	if !validHomeworkSubject(subject) {
		problem(w, 400, "invalid_request", "subject is not in the fixed list")
		return
	}
	hid := chi.URLParam(r, "id")
	// 编辑时先把现存媒体读出来：合并「至少一项」的判断、要删的行、以及磁盘上要清的文件，
	// 都基于同一次读取，避免在事务里重读。
	existing := map[string]string{}
	if hid != "" {
		var found int
		if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM homework WHERE id=? AND family_id=?`, hid, x.FamilyID).Scan(&found); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				problem(w, 404, "not_found", "homework not found")
				return
			}
			s.internalError(w, r, err)
			return
		}
		if err := s.readHomeworkMedia(ctx, x.FamilyID, hid, existing); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	var staleIDs, staleNames []string
	for _, mid := range r.MultipartForm.Value["remove_media"] {
		if storage, ok := existing[mid]; ok {
			staleIDs = append(staleIDs, mid)
			staleNames = append(staleNames, storage)
		}
	}
	// 不支持的格式只跳过并回报，不拖垮整批（PRD §4）。
	accepted := []homeworkCandidate{}
	skipped := []string{}
	for _, h := range files {
		kind, mimeType, ext, ok := inspectHomeworkUpload(h)
		if !ok {
			skipped = append(skipped, filepath.Base(h.Filename))
			continue
		}
		accepted = append(accepted, homeworkCandidate{h: h, kind: kind, mimeType: mimeType, ext: ext})
	}
	if description == "" && len(existing)-len(staleIDs)+len(accepted) == 0 {
		problem(w, 400, "invalid_request", "description or media is required")
		return
	}
	type saved struct {
		h                            *multipart.FileHeader
		storage, mid, kind, mimeType string
		size                         int64
	}
	savedFiles := []saved{}
	cleanup := func() {
		for _, v := range savedFiles {
			_ = os.Remove(filepath.Join(s.mediaDir, v.storage))
		}
	}
	for _, candidate := range accepted {
		src, err := candidate.h.Open()
		if err != nil {
			cleanup()
			s.uploadError(w, r, err)
			return
		}
		storage := id("media") + candidate.ext
		var size int64
		if candidate.kind == "image" {
			size, err = s.storeHomeworkImage(src, storage)
		} else {
			size, err = s.storeHomeworkVideo(src, storage)
		}
		_ = src.Close()
		if err != nil {
			cleanup()
			s.uploadError(w, r, err)
			return
		}
		savedFiles = append(savedFiles, saved{h: candidate.h, storage: storage, mid: id("hm"), kind: candidate.kind, mimeType: candidate.mimeType, size: size})
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	now := nowText(s.now())
	if hid == "" {
		hid = id("hw")
		_, err = tx.Exec(`INSERT INTO homework(id,family_id,date,subject,description,created_at) VALUES(?,?,?,?,?,?)`, hid, x.FamilyID, date, subject, description, now)
	} else {
		var res sql.Result
		res, err = tx.Exec(`UPDATE homework SET date=?,subject=?,description=? WHERE id=? AND family_id=?`, date, subject, description, hid, x.FamilyID)
		if err == nil {
			var changed int64
			if changed, err = res.RowsAffected(); err == nil && changed == 0 {
				cleanup()
				problem(w, 404, "not_found", "homework not found")
				return
			}
		}
	}
	var base int
	if err == nil {
		err = tx.QueryRow(`SELECT COALESCE(MAX(sort),-1) FROM homework_media WHERE family_id=? AND homework_id=?`, x.FamilyID, hid).Scan(&base)
	}
	if err == nil {
		for _, mid := range staleIDs {
			if _, err = tx.Exec(`DELETE FROM homework_media WHERE id=? AND family_id=? AND homework_id=?`, mid, x.FamilyID, hid); err != nil {
				break
			}
		}
	}
	if err == nil {
		for i, v := range savedFiles {
			_, err = tx.Exec(`INSERT INTO homework_media(id,family_id,homework_id,original_name,storage_name,media_type,mime_type,size_bytes,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, v.mid, x.FamilyID, hid, filepath.Base(v.h.Filename), v.storage, v.kind, v.mimeType, v.size, base+1+i, now)
			if err != nil {
				break
			}
		}
	}
	if err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		cleanup()
		s.internalError(w, r, err)
		return
	}
	// 提交成功后旧文件才从磁盘上消失；提交之前失败的文件由 cleanup 处理。
	for _, name := range staleNames {
		_ = os.Remove(filepath.Join(s.mediaDir, filepath.Base(name)))
	}
	writeJSON(w, 200, map[string]any{"id": hid, "skipped": skipped})
}

// readHomeworkMedia 把一条作业的媒体读成 id -> storage_name。
func (s *Server) readHomeworkMedia(ctx context.Context, family, homeworkID string, into map[string]string) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id,storage_name FROM homework_media WHERE family_id=? AND homework_id=?`, family, homeworkID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var mid, storage string
		if err = rows.Scan(&mid, &storage); err != nil {
			return err
		}
		into[mid] = storage
	}
	return rows.Err()
}

func (s *Server) deleteHomework(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	hid := chi.URLParam(r, "id")
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	// 文件和行都在事务里查：提交之后就不能再碰 s.db 了。
	rows, err := tx.Query(`SELECT storage_name FROM homework_media WHERE family_id=? AND homework_id=?`, x.FamilyID, hid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	names := []string{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		names = append(names, name)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		s.internalError(w, r, err)
		return
	}
	rows.Close()
	res, err := tx.Exec(`DELETE FROM homework WHERE id=? AND family_id=?`, hid, x.FamilyID)
	if err == nil {
		var changed int64
		if changed, err = res.RowsAffected(); err == nil && changed == 0 {
			problem(w, 404, "not_found", "homework not found")
			return
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
	for _, name := range names {
		_ = os.Remove(filepath.Join(s.mediaDir, filepath.Base(name)))
	}
	w.WriteHeader(204)
}

func (s *Server) deleteHomeworkMedia(w http.ResponseWriter, r *http.Request) {
	x := sess(r)
	hid := chi.URLParam(r, "id")
	mid := chi.URLParam(r, "mediaID")
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	var storage string
	if err = tx.QueryRow(`SELECT storage_name FROM homework_media WHERE id=? AND family_id=? AND homework_id=?`, mid, x.FamilyID, hid).Scan(&storage); err != nil {
		problem(w, 404, "not_found", "media not found")
		return
	}
	res, err := tx.Exec(`DELETE FROM homework_media WHERE id=? AND family_id=? AND homework_id=?`, mid, x.FamilyID, hid)
	if err == nil {
		var changed int64
		if changed, err = res.RowsAffected(); err == nil && changed == 0 {
			problem(w, 404, "not_found", "media not found")
			return
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
	_ = os.Remove(filepath.Join(s.mediaDir, filepath.Base(storage)))
	w.WriteHeader(204)
}
