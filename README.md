# GrowJoy

面向家庭的成长任务与积分奖励 H5。Go 服务同源提供 React 应用、SQLite 业务数据、认证会话和受保护的提交附件。

## 开发环境

要求 Go 1.22+、Node.js 22.22.2+，并已安装 Playwright Chromium。

```bash
npm install
npm run dev:server
```

另一个终端运行：

```bash
npm run dev
```

打开 `http://localhost:5173`（Vite 默认只监听 `localhost`，macOS 上解析为 IPv6 `::1`，用 `127.0.0.1` 会连不上）。Vite 会将 `/api` 代理到 `127.0.0.1:8080`。

也可以用一个命令同时启动两端，Ctrl-C 一并退出：

```bash
make          # 列出全部常用命令
make dev      # 后端 :8080 + 前端 :5173（等价于上面两条命令）
```

其余常用目标：`make install`、`make build`、`make test`、`make check`（完整 CI 门）、`make run`（构建后由 Go 单进程服务 `dist/`）、`make check-flow`、`make check-ui`、`make deploy`（构建并部署到远程主机）、`make stop`（清理占用 :8080 的残留后端）、`make clean`。

`npm run dev:server` 会幂等创建演示家庭。应用默认停在孩子端，进入家长端只需要家长密码：

- 孩子端：打开即用，没有登录步骤
- 家长端密码：`2468`（演示家庭，4 位数字）

## 用户模型

GrowJoy 面向单个家庭部署，服务只服务数据库中的第一个家庭（按创建时间），界面上不再输入家庭码，孩子也不再有 PIN。

- 孩子端是默认界面：能打开页面的人都能看到任务、提交证据、兑换愿望。
- 家长端（孩子管理、任务管理、愿望管理、成长统计）需要家长密码。
- 家长密码是 4 位数字，可以在家长端右上角账号菜单的「修改家长密码」里修改：需要先输入当前密码，改完旧密码立即失效、新密码可用于进入家长端（已打开的家长端不会被踢出）。用 `admin create-family` 建家庭时同样只接受 4 位数字。
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
  --password 2468 \
  --timezone Asia/Shanghai
```

`--code` 和 `--username` 只是数据库中的标识（`--username` 不再用于登录，界面只校验 `--password`）。家庭码不再需要输入：服务启动后始终使用数据库中第一个家庭，需要多个家庭时请分别部署；同一个数据库里第二次执行 `admin create-family` 会被直接拒绝，避免留下永远不可达的家庭。

为指定家庭幂等生成演示内容：

```bash
./growjoy seed-demo --family FAMILY01
```

## 生产运行

```bash
npm run build
go build -ldflags "-X main.version=$(git describe --always --dirty)" -o growjoy ./cmd/growjoy
GROWJOY_ADDR=127.0.0.1:8080 \
GROWJOY_DB=/srv/growjoy/growjoy.db \
GROWJOY_MEDIA=/srv/growjoy/media \
GROWJOY_DIST="$PWD/dist" \
GROWJOY_SECURE_COOKIES=true \
./growjoy serve
```

服务启动时向前执行嵌入式迁移，并启用 SQLite WAL、外键与 5 秒 busy timeout。首版按单进程、单副本部署；应由反向代理负责 TLS。数据库和媒体目录必须位于持久卷中，并作为一个一致单元备份。

健康检查：`GET /health/live`（返回 `{"status":"ok","version":...}`，版本来自构建时的 `-ldflags "-X main.version=..."`，未注入时为 `dev`）和 `GET /health/ready`（数据库可用、且所服务家庭的时区能加载时才返回 200，否则 503）。启动日志会打印本次实际服务的家庭码。

前端不请求任何外部资源：Fredoka 字体已自托管在 `public/fonts/`，中文使用系统自带字体栈，页面没有第三方域名请求。

单进程运行时也可以做备份与媒体清理：

```bash
./growjoy backup --out /srv/growjoy/backup
./growjoy gc --media          # 只列出没有附件记录的文件
./growjoy gc --media --delete # 真正删除
```

`backup` 用 `VACUUM INTO` 取数据库一致性快照，因此可以在服务运行时执行；输出目录里已存在 `growjoy.db` 或 `media.tar` 时会拒绝覆盖，请换一个目录。`gc --media` 只处理文件名形如 `media_<32位hex>.<扩展名>` 的上传文件，其他文件一律不动；数据库里一条附件记录都没有时会拒绝删除（通常是 `GROWJOY_DB` 指错了库），确认无误后加 `--force`。

## 远程部署

`make deploy` 把新版本推到一台已在运行的远程主机（默认 `rocky.home`）：本地构建 `dist/` 并交叉编译 `linux/amd64` 静态二进制，rsync 到远端 `bin/` 与 `dist/`，重启 systemd 用户服务，最后轮询 `/health/ready` 并核对 `/health/live` 的版本号等于本地 `git describe --always --dirty`，任一步失败即以非零码退出。

```bash
make deploy
make deploy DEPLOY_HOST=user@host DEPLOY_URL=http://host:9080 DEPLOY_DIR=/home/user/growjoy
```

可覆盖的变量：`DEPLOY_HOST`（默认 `rocky.home`，需免密 ssh）、`DEPLOY_DIR`（默认 `/home/pengchang/growjoy`）、`DEPLOY_URL`（默认 `http://192.168.0.208:9080`，必须指向 `GROWJOY_ADDR` 实际监听的地址）、`DEPLOY_UNIT`（默认 `growjoy`）、`DEPLOY_STAGE`（默认 `/tmp/growjoy-deploy`，交叉编译产物的暂存目录，不落在仓库里）。

它只覆盖 `bin/` 与 `dist/`，不碰 `data/`，因此数据库与上传文件在升级后保持原样。首次部署仍需手工准备一次（远端目录、systemd 用户服务、`admin create-family` 建家庭）：

```bash
ssh rocky.home 'mkdir -p ~/growjoy/bin ~/growjoy/dist'
ssh rocky.home 'GROWJOY_DB=$HOME/growjoy/data/growjoy.db GROWJOY_MEDIA=$HOME/growjoy/data/media \
  ~/growjoy/bin/growjoy admin create-family --code HOME --name 我们的家 \
  --username parent --display-name 家长 --password 1357 --timezone Asia/Shanghai'
```

远端日志用 `ssh rocky.home 'systemctl --user status growjoy -n 50'`（跟随时加 `-f`）查看；若该主机没有用户级 journal 文件，`journalctl --user -u growjoy` 会是空的，此时改用 `sudo journalctl _SYSTEMD_USER_UNIT=growjoy.service`。

明文 HTTP 直连（不套反向代理）时端口要写成 `GROWJOY_ADDR=0.0.0.0:9080` 且 `GROWJOY_SECURE_COOKIES=false`：前者只绑回环则局域网访问不到，后者设为 `true` 会让浏览器在 HTTP 下不回传 `growjoy_session`，每个请求都会重开会话。这种实例只应留在局域网或 Tailscale 内，不要映射到公网。

## 访问限制与清理

认证接口有两层独立限制，参数写死在 `internal/server/ratelimit.go`：

- 按客户端地址限流：60 次突发、之后每秒 1 次，超过返回 `429 too_many_requests`。
- 按家庭限制家长密码失败次数：10 次失败后每个新的错误尝试返回 429，每 30 秒恢复 1 次。**只有失败才消耗额度**，因此输错密码不会把家里锁在门外，攻击者也无法靠乱试封锁家长端。登录与「修改家长密码」共用这份额度。反向代理部署时所有请求共享同一个地址，按地址的限流会退化为全局限制，此时按家庭的失败额度才是主要防线。
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
