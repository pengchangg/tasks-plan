package server

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type FamilyInput struct{ Code, Name, Timezone, Username, DisplayName, Password string }

func (s *Server) CreateFamily(ctx context.Context, in FamilyInput) error {
	if in.Code == "" || in.Name == "" || in.Username == "" || len(in.Password) < 8 {
		return fmt.Errorf("code, name, username and password (minimum 8 characters) are required")
	}
	if in.Timezone == "" {
		in.Timezone = "Asia/Shanghai"
	}
	if _, err := time.LoadLocation(in.Timezone); err != nil {
		return fmt.Errorf("invalid IANA timezone %q: %w", in.Timezone, err)
	}
	if in.DisplayName == "" {
		in.DisplayName = in.Username
	}
	hash, err := s.hashPassword(ctx, in.Password)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	fid := id("fam")
	now := nowText(s.now())
	if _, err = tx.ExecContext(ctx, `INSERT INTO families(id,code,name,timezone,created_at) VALUES(?,?,?,?,?)`, fid, in.Code, in.Name, in.Timezone, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO parents(id,family_id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?,?)`, id("par"), fid, in.Username, in.DisplayName, hash, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) SeedDemo(ctx context.Context, code string) error {
	var family, timezone string
	if err := s.db.QueryRowContext(ctx, `SELECT id,timezone FROM families WHERE code=?`, code).Scan(&family, &timezone); err != nil {
		return fmt.Errorf("family %q: %w", code, err)
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return fmt.Errorf("family %q timezone: %w", code, err)
	}
	now := s.now()
	today := now.In(location).Format("2006-01-02")
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// The app opens the family's oldest child and lists children, tasks and
	// ledger entries in creation order, so every seeded row gets its own
	// instant: identical stamps would leave the demo ordering to chance.
	seeded := 0
	seedStamp := func(base time.Time) string {
		seeded++
		return nowText(base.Add(time.Duration(seeded) * time.Millisecond))
	}
	upsertChild := func(name, avatar, color string, level int, exp float64, balance int) (string, error) {
		var cid string
		e := tx.QueryRowContext(ctx, `SELECT id FROM children WHERE family_id=? AND name=?`, family, name).Scan(&cid)
		if e == nil {
			return cid, nil
		}
		if e != sql.ErrNoRows {
			return "", e
		}
		cid = id("child")
		_, e = tx.ExecContext(ctx, `INSERT INTO children(id,family_id,name,avatar,color,level,experience,points_balance,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, cid, family, name, avatar, color, level, exp, balance, seedStamp(now))
		return cid, e
	}
	mia, err := upsertChild("米娅", "🌻", "#ffb547", 4, 372, 185)
	if err != nil {
		return err
	}
	leo, err := upsertChild("乐乐", "🚀", "#55b8a4", 2, 138, 80)
	if err != nil {
		return err
	}
	type td struct {
		child, title, desc, cat, rule, status string
		points                                int
	}
	tasks := []td{{mia, "整理自己的书桌", "把书本分类放回书架，擦干净桌面。", "生活自理", "daily", "todo", 20}, {mia, "阅读 20 分钟", "选择一本喜欢的书，安静阅读 20 分钟。", "学习成长", "daily", "pending_review", 30}, {mia, "给植物浇水", "观察植物的土壤，适量浇水并收好水壶。", "家庭责任", "daily", "completed", 15}, {mia, "帮忙摆放餐具", "晚餐前帮家人准备好餐具。", "家庭责任", "once", "completed", 15}, {leo, "收拾玩具箱", "把玩具放回对应的位置。", "生活自理", "daily", "todo", 20}}
	for _, v := range tasks {
		var exists int
		if tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM task_templates WHERE family_id=? AND child_id=? AND title=?`, family, v.child, v.title).Scan(&exists); exists > 0 {
			continue
		}
		tid, iid := id("tpl"), id("task")
		created := seedStamp(now.Add(-48 * time.Hour))
		if _, err = tx.ExecContext(ctx, `INSERT INTO task_templates(id,family_id,child_id,title,description,category,points,repeat_rule,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, tid, family, v.child, v.title, v.desc, v.cat, v.points, v.rule, created, created); err != nil {
			return err
		}
		key := today
		if v.rule == "once" {
			key = "once"
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO task_instances(id,family_id,template_id,child_id,period_key,title,description,category,points,repeat_rule,due_date,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, iid, family, tid, v.child, key, v.title, v.desc, v.cat, v.points, v.rule, today, v.status, created); err != nil {
			return err
		}
		if v.status == "pending_review" {
			sid := id("sub")
			if _, err = tx.ExecContext(ctx, `INSERT INTO task_submissions(id,family_id,task_instance_id,child_id,note,submitted_at) VALUES(?,?,?,?,?,?)`, sid, family, iid, mia, "我读完了《小王子》第三章！", seedStamp(now.Add(-time.Hour))); err != nil {
				return err
			}
		}
	}
	type wd struct {
		title, desc, icon, color string
		cost                     int
	}
	wishes := []wd{{"周末看一部电影", "和家人一起选一部喜欢的电影。", "🎬", "#ffcf70", 120}, {"选择一次晚餐", "今晚的菜单由你来决定。", "🍕", "#ff9980", 80}, {"公园探险半日游", "安排一次特别的户外探险。", "🗺️", "#9bd8c8", 260}, {"睡前故事加长版", "今晚拥有两本睡前故事。", "📚", "#bdb2ed", 60}}
	for _, v := range wishes {
		var n int
		_ = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM wishes WHERE family_id=? AND title=?`, family, v.title).Scan(&n)
		if n == 0 {
			stamp := seedStamp(now)
			_, err = tx.ExecContext(ctx, `INSERT INTO wishes(id,family_id,title,description,points_cost,icon,color,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)`, id("wish"), family, v.title, v.desc, v.cost, v.icon, v.color, stamp, stamp)
			if err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (s *Server) EnsureDemo(ctx context.Context) error {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM families WHERE code='DEMO'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if err := s.CreateFamily(ctx, FamilyInput{Code: "DEMO", Name: "演示家庭", Username: "parent", DisplayName: "演示家长", Password: "growjoy2468"}); err != nil {
			return err
		}
	}
	return s.SeedDemo(ctx, "DEMO")
}

func (s *Server) MediaDir() string { return s.mediaDir }
func EnsurePath(path string) error { return os.MkdirAll(filepath.Dir(path), 0700) }
