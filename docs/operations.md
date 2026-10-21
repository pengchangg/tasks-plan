# 运行与运维

本文覆盖生产环境的运行方式、配置、安全边界、备份与排错。首次部署、systemd 单元、反向代理与 Cloudflare 隧道的完整步骤在 [DEPLOY.md](../DEPLOY.md)。

## 运行时形态

- **一个进程、一个副本**：Go 二进制同时提供 API、认证、上传文件和 `dist/` 里的 SPA。不要起第二份副本，也不要让两个进程指向同一个数据库。
- **状态只有两样**：SQLite 文件（`GROWJOY_DB`）和媒体目录（`GROWJOY_MEDIA`），必须在持久卷上，并作为一个一致单元备份。
- 服务启动时执行嵌入式迁移，启用 WAL、外键和 5 秒 busy timeout；部署只替换二进制与 `dist/`，不碰 `data/`。
- 反向代理负责 TLS。进程本身不做 HTTPS。

```bash
GROWJOY_ADDR=0.0.0.0:9080 \
GROWJOY_DB=/home/user/growjoy/data/growjoy.db \
GROWJOY_MEDIA=/home/user/growjoy/data/media \
GROWJOY_DIST=/home/user/growjoy/dist \
GROWJOY_SECURE_COOKIES=false \
./bin/growjoy serve
```

## 配置项

环境变量只在 `cmd/growjoy/main.go` 读取；空字符串视为未设置。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GROWJOY_ADDR` | `127.0.0.1:8080` | 监听地址；`serve --addr` 可覆盖 |
| `GROWJOY_DB` | `data/growjoy.db` | SQLite 文件；`backup` / `gc` 也读它 |
| `GROWJOY_MEDIA` | `data/media` | 上传目录；启动时以 0700 创建 |
| `GROWJOY_DIST` | `dist` | SPA 目录；设为空字符串可关闭静态文件服务 |
| `GROWJOY_SECURE_COOKIES` | `false` | 必须是字面量 `true` 才给会话 cookie 加 `Secure`。**明文 HTTP 下保持 `false`**，否则浏览器不会回传 cookie |

其余行为是编译进二进制或 SQLite 的常量：限流参数在 `internal/server/ratelimit.go`，会话时长 30 天（孩子）/ 12 小时（家长），幂等键保留 30 天，清理周期 1 小时。

## 命令行

```bash
growjoy serve [--addr 127.0.0.1:8080] [--demo]
growjoy admin create-family --code HOME --name 我们的家 --username parent \
    --display-name 家长 --password 1357 --timezone Asia/Shanghai
growjoy seed-demo --family HOME
growjoy backup --out /srv/growjoy/backup
growjoy gc --media [--delete] [--force]
```

- `serve --demo`：幂等创建/更新演示家庭 `DEMO`（密码 `2468`），只用于开发与 E2E。
- `admin create-family`：**必须在起服务之前执行**。库里没有家庭时孩子端返回 `409 no_family`。`--password` 必须正好 4 位数字，`--timezone` 必须是可加载的 IANA 名称。一个库只能有一个家庭，第二次执行会被拒绝。
- `seed-demo`：给指定家庭灌演示数据；真实使用不需要。
- `backup` / `gc`：见下文。

服务启动日志会打印本次实际服务的家庭码（`serving family code=...`）。

## 认证与限流

家长密码是应用里唯一的凭证，因此公开认证接口有两层独立预算：

| 预算 | 参数 | 作用 |
|---|---|---|
| 按客户端地址 | 60 次突发，之后每秒 1 次 | 保护进程与 argon2 并发闸门；超限 `429 too_many_requests` |
| 按家庭失败次数 | 10 次失败后每个新错误尝试返回 429，每 30 秒恢复 1 次 | 保护家长密码；**只有输错才消耗**，正确密码不扣额度 |

- 登录（`/auth/parent`）与修改密码（`/auth/parent/password`）共用同一份失败预算，不能把攻击者的尝试翻倍。
- argon2 同时最多 4 次校验（每次 64 MiB），占满时返回 `503 unavailable`。
- 客户端地址取 TCP 对端地址，**刻意忽略 `X-Forwarded-For`**；反向代理后面所有请求共享一个地址，按地址的限流会退化成全局限流，这时按家庭的失败预算才是真正的防线。
- 限流状态在内存里，重启即清零。空闲超过 30 分钟的桶由每小时的 `Sweep` 清理。

会话：cookie `growjoy_session`（`HttpOnly`、`SameSite=Lax`、`Path=/`、无 `Domain`）。数据库只存 token 的 SHA-256。孩子端会话 30 天；家长会话 12 小时，而且页面刷新就会回到孩子端、需要重新输密码。

CSRF 防护来自同源校验（`Origin` 的 host 必须等于 `Host`，另加 `Sec-Fetch-Site` 检查）与 `SameSite=Lax`。**反向代理必须保留浏览器发来的 `Host`**：nginx 用 `proxy_set_header Host $host`，其他代理同理，否则所有写请求都会 `403 origin_mismatch`。

## 健康检查与日志

| 接口 | 含义 |
|---|---|
| `GET /health/live` | 进程活着，返回 `{"status":"ok","version":"..."}`。`version` 是构建时 `-ldflags "-X main.version=$(git describe --always --dirty)"` 注入的 |
| `GET /health/ready` | 数据库可查询、且所服务家庭的时区能加载时返回 200；否则 `503 unavailable`。库里还没有家庭时也返回 200（可正常启动，但孩子端会 `no_family`） |

第 1 天的排查顺序：`/health/ready` → `systemctl --user status <unit>` → 日志里的 `serving family` 与 `error` 行。部署脚本会轮询 `/health/ready` 并要求 `/health/live` 的版本等于本地 `git describe`。

日志是 `slog` 默认文本格式，写在进程的 stdout/stderr（systemd 下用 `journalctl --user -u <unit> -f`）。每个请求一行访问日志；内部错误只进日志，返回给客户端的永远是固定的 `internal` 错误。

## 备份与恢复

```bash
growjoy backup --out /srv/growjoy/backup/2026-10-21
```

- 用 `VACUUM INTO` 取数据库一致快照，**可以在服务运行时执行**；媒体目录打成 `media.tar`（平铺，无子目录）。
- 输出目录已存在 `growjoy.db` 或 `media.tar` 时会拒绝覆盖，每次换个目录。
- 备份单元是「数据库 + 媒体」两者，恢复时必须一起还原，否则附件记录会指向不存在的文件。

恢复：停服务 → 把 `growjoy.db` 放回 `GROWJOY_DB`、`media.tar` 解到 `GROWJOY_MEDIA` → 起服务 → 检查 `/health/ready` 与首页。数据库与媒体不一致时用 `gc` 报告孤儿文件。

## 媒体清理

```bash
growjoy gc --media            # 只列出没有数据库记录的文件
growjoy gc --media --delete   # 真正删除
```

- 只处理文件名形如 `media_<32 位 hex>.<扩展名>` 的文件，其它文件不动。
- 数据库里一条附件记录都没有时拒绝删除（通常意味着 `GROWJOY_DB` 指错了库）；确认后加 `--force`。
- 正常删除孩子、任务、作业、兑换时文件会同步清理，`gc` 只是兜底。

## 升级

日常升级一条命令：

```bash
make deploy
# 覆盖目标：DEPLOY_HOST / DEPLOY_DIR / DEPLOY_URL / DEPLOY_UNIT / DEPLOY_STAGE
```

它本地构建 `dist/`、交叉编译 `linux/amd64`、rsync、重启 systemd 用户服务，最后校验 `/health/ready`、`/health/live` 的版本号以及首页引用的 JS 产物。任一失败即非零退出，远端 `data/` 不受影响。

推送到 `main` 后 Gitea Actions 会自动执行同样的流程；两条路径不要同时跑（单副本机器上两次 rsync + restart 会混出新的前端和旧的二进制）。

## 排错

| 现象 | 排查方向 |
|---|---|
| 孩子端页面提示无法进入 / `409 no_family` | 还没建家庭；执行 `admin create-family` 后重启服务 |
| 所有写请求 `403 origin_mismatch` | 代理改写了 `Host`，或访问地址与代理转发地址不一致 |
| `429 too_many_requests` | 触发限流。连续输错 10 次家长密码后要等额度恢复；不要为此放宽参数 |
| `/health/ready` 一直 503 | 数据库不可写/不可读，或 `/usr/share/zoneinfo/<家庭时区>` 缺失 |
| 页面打开但静态资源 404 后白屏 | 服务对未知路径一律返回 `index.html`；检查 `GROWJOY_DIST` 与 `dist/` 是否完整 |
| 每次请求都像没登录 | `GROWJOY_SECURE_COOKIES=true` 却在明文 HTTP 下访问，cookie 被浏览器丢弃 |
| 部署卡在版本校验 | 远端进程没重启成功、`DEPLOY_URL` 指向旧实例，或首页缓存了旧 `assets/` |
| 上传报 `413` / `415` | 检查文件数（≤6）、图片（≤10 MiB，jpeg/png/webp）、视频（≤100 MiB，mp4/webm）与请求总量（≤100 MiB） |
| 磁盘增长异常 | `growjoy gc --media` 看孤儿文件；备份目录与 `data/` 是否在同一卷 |
