# 开发指南

## 环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Go | 1.22+ | `go.mod` 声明 1.22；SQLite 驱动 `modernc.org/sqlite` 是纯 Go，不需要 cgo |
| Node.js | 22.22.2+ | 锁文件里最高要求来自 `jsdom`；不要用更低的版本 |
| Playwright Chromium | 按需 | 只有 `check:flow` / `check:ui` 需要：`npx playwright install --with-deps chromium` |

## 本地启动

```bash
npm install
make dev
```

`make dev` 把后端（`go run ./cmd/growjoy serve --demo`，`127.0.0.1:8080`）和 Vite（`:5173`）放在一起，Ctrl-C 一并退出。也可以分两个终端：

```bash
npm run dev:server   # 后端 + 演示家庭（幂等创建）
npm run dev          # 前端，/api 代理到 127.0.0.1:8080
```

打开 `http://localhost:5173`。演示账号：孩子端免登录，家长端密码 `2468`。演示数据是一个孩子「米娅」、4 个任务、4 个愿望和十天历史。

第一次启动会创建 `data/growjoy.db`、`data/media/`（均是 gitignored）。

## 命令

### npm

| 命令 | 作用 |
|---|---|
| `npm run dev` | Vite 开发服务器（`:5173`），`/api` 代理到 `:8080` |
| `npm run dev:server` | `go run ./cmd/growjoy serve --demo` |
| `npm run build` | `tsc -b && vite build` → `dist/`（类型检查不产出 JS） |
| `npm test` | `vitest run`：`src/domain.test.ts` + `src/proverbs.test.ts` + `src/lunar.test.ts` + `src/features/klotski.test.ts` |
| `npm run test:go` | `go test ./...`（不带 `-race`，与 `make test-go` 不同） |
| `npm run check:flow` | 行为 E2E：构建后启动真实服务，走完整孩子/家长流程 |
| `npm run check:ui` | 视觉门：16 个视口/路由场景的截图与溢出检查 |
| `npm run preview` | 静态预览 `dist/`，没有 `/api` 代理，不能用于 E2E |

### make

| 目标 | 作用 |
|---|---|
| `make` / `make help` | 列出全部目标 |
| `make dev` | 后端 + 前端一起起 |
| `make server` / `make web` | 只起后端 / 只起前端 |
| `make run` | 构建后用单个 Go 进程服务 `dist/`（`:8080`） |
| `make build` / `make test` | 构建 / `go vet` + Go 测试（`-race`）+ vitest |
| `make precommit` | 提交前快速门：`test` + `build`（等价于 `go vet` + `go test -race` + `npm test` + `npm run build`） |
| `make check` | 完整门：`test` + 两个 Playwright 门 |
| `make install-hooks` | 启用 `.githooks/pre-commit`（跑 `make precommit`） |
| `make deploy` | 构建、交叉编译、rsync、重启远端服务并校验健康与版本，见 [DEPLOY.md](../DEPLOY.md) |
| `make stop` | 杀掉占用 `:8080` 的残留进程 |
| `make clean` / `make distclean` | 清理构建产物 / 连 `data/` 一起重置（后者会二次确认） |

## 代码约定

### Go

- 处理器是 `Handler()` 里直接注册的方法：`func (s *Server) verbNoun(w http.ResponseWriter, r *http.Request)`。文件按关注点拆，不按处理器拆。
- 保存类接口双用途：`chi.URLParam(r, "id") == ""` 是新建，否则是更新（`saveChild`、`saveTask`、`saveWish`）。
- 输出用 `writeJSON(w, status, v)`；错误一律 `problem(w, status, code, message)`。内部错误走 `s.internalError` / `s.uploadError`，**绝不**把 `err.Error()` 传给客户端。
- 入参用 `decode(r, v)`：1 MiB 上限 + `DisallowUnknownFields()`。所以新增字段必须同时改 Go input struct 与 `src/types.ts`。
- 原始 SQL、`?` 占位符、没有 ORM/预编译语句；扫描进导出的 DTO（camelCase json tag 对 snake_case 列）。
- 多写流程用显式事务（`BeginTx` + `defer Rollback` + `Commit`）；**提交后不要再用 `s.db`**。连接池只有一条连接，事务里用 `s.db` 会死锁。
- 时间只用 `s.now()`（测试会替换），日期、周期一律走家庭时区。ID 用 `id(prefix)`。
- 新配置只能加在 `cmd/growjoy/main.go` 的 `open()` 与 `server.Config` 里（目前只有 `DBPath`、`MediaDir`、`DistDir`、`SecureCookies`、`Version`）。
- 迁移文件命名 `NNN_name.sql`，编号 ≥ 2 的新文件只跑一次；已应用的迁移**不要改**。`001_init.sql` 每次启动都重跑，必须保持幂等。

### TypeScript / React

- `src/App.tsx` 只放外壳、路由表和任务/愿望/成长/家长管理这几屏；跨模块共用的展示原语放 `src/ui.tsx`，自成一体的功能（带自己的常量与多个组件）放 `src/features/<name>.tsx`（现有 `homework.tsx`、`stats.tsx`、`ledger.tsx`）。**不要继续往 `App.tsx` 里堆新功能**：新功能从 `src/features/` 开始，feature 不要反向 import `App.tsx`（会成环）。
- 状态只在 `useAppStore()` 里，作为 `store` prop 往下传；没有 Context、Redux、按页面取数或 `localStorage`。
- 写操作加在 `actions` 上并通过 `run(() => ...)` 执行（它会清空消息、执行、刷新服务端状态）。统计和作业是两处例外，见 `store.ts` 的注释。`run` 会把操作结果透出来（失败是 `undefined`），`toggleHomeworkDone` 就靠它把服务端的 `awarded` 交给那张卡，前端不自己猜数字。
- `TaskForm` 选 `weekly` 时是一排 `.weekday-chip` 复选（`repeatWeekdays`，加 `工作日`/`周末`/`全选` 快捷），`repeatWeekday` 只是首日；`repeatWeekdays: []` 回到旧的单日语义。
- 请求都走 `request()`；需要幂等的写操作必须用 `json(method, value, true)`。`idempotencyKey()` 在非 HTTPS 环境会退化到 `crypto.getRandomValues`，不要在请求路径上直接调 `crypto.randomUUID()`。
- `src/types.ts` 与 Go DTO 一一对应；写请求体只用 `ChildInput` / `TaskInput` / `WishInput`，禁止回传服务端 DTO。
- 日期展示只用 `src/domain.ts` / `dateText` 旁的辅助函数（读家庭时区）。组件需要「今天」时接收 prop，不自己 `new Date()`。
- 样式只在 `src/styles.css`：每行一条压缩规则、`:root` 变量、手写类名，只有 760px / 430px 两个断点。中文类名用于任务分类与作业学科（`cat-学习成长`、`subject-语文`），新增分类需要同时加规则和下拉选项。
- 界面文案直接写中文，没有 i18n 层。

## 测试

### Go（`go test ./...`）

- 只有三个测试文件：`internal/server/server_test.go`（白盒，真实 SQLite 文件 + `httptest`）、`internal/server/games_test.go`（华容道：五关布局的 BFS 可解性校验与进度/计分/门槛行为）与 `cmd/growjoy/main_test.go`（CLI 命令）。
- 复用现有辅助函数：`testServer`、`doJSON`、`parentCookie`、`childCookie`、`sessionFor`、`getStateTest`、`multipartRequest`、`homeworkRequest` 等。
- 约定：无子测试、无表驱动、无 `t.Parallel`；失败信息带 HTTP 状态与响应体。
- 时间敏感的数据要**先**替换 `s.now` 再写入种子（`testServer` 已经按墙上时钟灌过 DEMO 种子，之后再改 `s.now` 会让第二个家庭的时间戳比 DEMO 还早，`resolvedFamily` 就会换人）。
- 迁移只加新文件 `NNN_name.sql`（版本号 ≥ 2，且下一个必须 ≥ 011——008 写过又整体回滚，跑过它的库会留下一行 `schema_migrations=8`，再发一个 8 会被静默跳过；009 与 010 已占用），**不要改 `001_init.sql`**：已应用过的 `ALTER TABLE ADD COLUMN` 重跑会失败，而新库会在 001 之后把 002…NNN 一个个跑一遍。重启测试按 `.sql` 文件数自动计数，无需跟着改。
- `testServer` 不是万能的：重启测试与 `no_family` 测试会自己构造 `Config`；需要第二个家庭时用 `otherFamily`。

### 前端（`npm test`）

`vitest run` 跑 `src/domain.test.ts`（成长日历的日期分桶）、`src/proverbs.test.ts`（每日谚语：拼音逐字对齐、英文意译、按日期轮换）与 `src/lunar.test.ts`（农历/节日换算与「休」/「班」角标）。没有 DOM 测试、没有覆盖率门槛。

### 端到端（`check:flow` / `check:ui`）

两个脚本都由 `scripts/with-service.mjs` 包裹：构建二进制 → 分配空闲端口 → `serve --demo`（临时数据库与媒体目录）→ 等 `/health/ready` → 跑 Playwright → 清理。

- `check:flow` 走真实用户旅程，并用 `page.evaluate(fetch('/api/v1/state'))` 断言服务端状态；控制台错误会让它失败。截图落在 `.artifacts/ui/`。
- `check:ui` 在 375/390/1440 三种视口下遍历路由，检查横向溢出、文本长度与截图；**没有**控制台错误白名单。
- 两个脚本硬编码演示数据、中文可访问名与 CSS 类名。改界面文案、类名或演示数据时必须同步改脚本。

## 提交与 CI

- 本地钩子：`make install-hooks` 后每次提交跑 `make precommit`。钩子只存在于装过的机器上，不能当流水线。
- 推送到 `main` 后，Gitea Actions 先跑 `make precommit`，再 `make deploy`。CI 只部署 `main`，并且用 `concurrency` 串行化（单副本机器上两次 rsync + restart 会混出新的 `dist/` 与旧的二进制）。
- 两个 Playwright 门不进 CI，发布前手动跑 `make check`。

## 常见坑

| 现象 | 原因 |
|---|---|
| 改了 `src/` 但页面没变 | Go 服务只服务 `dist/`，必须 `npm run build`；开发时用 Vite |
| 所有 POST 都 `403 origin_mismatch` | 代理改写了 `Host`。`vite.config.mjs` 必须保持 `changeOrigin: false` |
| 前端连不上后端 | Vite 代理硬编码 `127.0.0.1:8080`，改 `GROWJOY_ADDR` 时也要改 `vite.config.mjs` |
| 局域网 HTTP 下提交报错 | `crypto.randomUUID()` 只在安全上下文存在，`idempotencyKey()` 的降级分支必须保留 |
| 日期差一天 / 统计对不上 | 用了设备本地时间。所有日期必须走家庭时区 |
| `npm install` 后依赖大版本跳变 | `package.json` 里多数依赖声明为 `latest`，装包请显式 `npm install <pkg>` 并提交锁文件 |
| `go test` 卡住 | 事务里访问了 `s.db`（池子只有一条连接） |
| E2E 启动失败 | 没装 Playwright Chromium，或导出了 `GROWJOY_SECURE_COOKIES=true`（明文 HTTP 下 cookie 不会带回来） |
