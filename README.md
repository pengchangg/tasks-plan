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

`npm run dev:server` 会幂等创建演示家庭。演示凭据：

- 家庭码：`DEMO`
- 家长：`parent` / `growjoy2468`
- 孩子 PIN：`2468`

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
- 按家庭身份限制凭据失败次数：10 次失败后每个新的错误尝试返回 429，每 30 秒恢复 1 次。**只有失败才消耗额度**，因此孩子连续输错 PIN 不会把家长锁在门外，攻击者也无法靠乱试把某一家锁死。反向代理部署时所有请求共享同一个地址，按地址的限流会退化为全局限制，此时按家庭的失败额度才是主要防线。
- argon2 校验并发上限为 4（单次 64 MiB），占满且请求超时则返回 `503 unavailable`。

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
