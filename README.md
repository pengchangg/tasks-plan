# GrowJoy

面向家庭的成长任务与积分奖励 H5。Go 服务同源提供 React 应用、SQLite 业务数据、认证会话和受保护的提交附件。

## 开发环境

要求 Go 1.22+、Node.js 20+，并已安装 Playwright Chromium。

```bash
npm install
npm run dev:server
```

另一个终端运行：

```bash
npm run dev
```

打开 `http://127.0.0.1:5173`。Vite 会将 `/api` 代理到 `127.0.0.1:8080`。

`npm run dev:server` 会幂等创建演示家庭。应用默认停在孩子端，进入家长端只需要家长密码：

- 孩子端：打开即用，没有登录步骤
- 家长端密码：`growjoy2468`（演示家庭）

## 用户模型

GrowJoy 面向单个家庭部署，服务只服务数据库中的第一个家庭（按创建时间），界面上不再输入家庭码，孩子也不再有 PIN。

- 孩子端是默认界面：能打开页面的人都能看到任务、提交证据、兑换愿望。
- 家长端（孩子管理、任务管理、愿望管理、成长统计）需要家长密码。
- 家长权限只属于本次访问：刷新或重新打开页面都会回到孩子端，再次进入家长端要重新输入密码；点击「回到孩子端」也会立即收回家长权限。

## 创建家庭

先构建命令：

```bash
go build -o growjoy ./cmd/growjoy
./growjoy admin create-family \
  --code FAMILY01 \
  --name "我的家庭" \
  --username parent \
  --display-name "家长" \
  --password 'replace-with-a-strong-password' \
  --timezone Asia/Shanghai
```

`--code` 和 `--username` 只是数据库中的标识（`--username` 不再用于登录，界面只校验 `--password`）。家庭码不再需要输入：服务启动后始终使用数据库中第一个家庭，需要多个家庭时请分别部署。

为指定家庭幂等生成演示内容：

```bash
./growjoy seed-demo --family FAMILY01
```

## 生产运行

```bash
npm run build
go build -o growjoy ./cmd/growjoy
GROWJOY_ADDR=127.0.0.1:8080 \
GROWJOY_DB=/srv/growjoy/growjoy.db \
GROWJOY_MEDIA=/srv/growjoy/media \
GROWJOY_DIST="$PWD/dist" \
GROWJOY_SECURE_COOKIES=true \
./growjoy serve
```

服务启动时向前执行嵌入式迁移，并启用 SQLite WAL、外键与 5 秒 busy timeout。首版按单进程、单副本部署；应由反向代理负责 TLS。数据库和媒体目录必须位于持久卷中，并作为一个一致单元备份。

健康检查：`GET /health/live` 和 `GET /health/ready`。

## 访问限制与清理

认证接口有两层独立限制，参数写死在 `internal/server/ratelimit.go`：

- 按客户端地址限流：60 次突发、之后每秒 1 次，超过返回 `429 too_many_requests`。
- 按家庭限制家长密码失败次数：10 次失败后每个新的错误尝试返回 429，每 30 秒恢复 1 次。**只有失败才消耗额度**，因此输错密码不会把家里锁在门外，攻击者也无法靠乱试封锁家长端。反向代理部署时所有请求共享同一个地址，按地址的限流会退化为全局限制，此时按家庭的失败额度才是主要防线。
- argon2 校验并发上限为 4（单次 64 MiB），占满且请求超时则返回 `503 unavailable`。

写接口会校验 `Origin` 与请求的 `Host` 是否同源，因此反向代理必须保留浏览器发送的 `Host`（nginx 用 `proxy_set_header Host $host`）：Host 被改写成上游地址时，所有写请求都会返回 `403 origin_mismatch`。`npm run dev` 的 Vite 代理已按此配置（`changeOrigin: false`）。

服务端内部错误（数据库、文件系统）只写入日志，返回给客户端的固定是 `{"error":{"code":"internal","message":"internal server error"}}`，不会回显原始错误文本。过期会话与超过 30 天的幂等键会在 `serve` 启动时以及此后每小时清理一次，无需外部定时任务。

## 验证

```bash
go test ./...
npm test
npm run build
npm run check:flow
npm run check:ui
```

两个 Playwright 命令会各自创建临时 SQLite 数据库和媒体目录、选择动态端口、启动真实 Go 服务，并在结束时清理。

CI（`.github/workflows/ci.yml`）在 push 到 `main`、发起 PR 或手动触发时跑同一套检查：`go`（`go vet` + `go test`）与 `web`（`npm ci` + `npm test` + `npm run build`）并行，两者通过后运行 `e2e`（安装 Chromium 后跑 `check:flow` 与 `check:ui`），并把 `.artifacts/ui` 截图作为构建产物上传。CI 一律用 `npm ci` 从 `package-lock.json` 安装。
