# GrowJoy 部署手册

面向「一台常驻 Linux 主机 + 家庭局域网访问」的部署。本手册描述的实例已实际部署并验证过：`ssh rocky.home`（`192.168.0.208`，Rocky Linux 10.2 x86_64，用户 `pengchang`），访问地址 `http://192.168.0.208:9080`。

## 运行时形态

一个 Go 二进制对外提供 JSON API、会话认证、受保护的上传文件与预构建的 SPA（`dist/`）。全部状态就是**一份 SQLite 文件 + 一个媒体目录**。

- **单进程、单副本**：`Open` 把连接池设为 `SetMaxOpenConns(1)`，WAL 与外键是在这一条连接上启用的。不要让两个进程指向同一个数据库，也不要起第二份副本。
- **数据必须落在持久卷**：`GROWJOY_DB` 与 `GROWJOY_MEDIA` 要能长期保存，且必须**作为一个一致单元**备份（见下文备份一节）。
- **构建不需要在目标机上做**：本地交叉编译静态二进制 + `npm run build` 出 `dist/`，只把两者传到远端。目标机不需要 Go、Node 或构建链。

## 环境要求

本地（构建机）：

|要求|说明|
|---|---|
|Go 1.22+|本手册用 1.27.1 验证；`modernc.org/sqlite` 是纯 Go，`CGO_ENABLED=0` 可静态交叉编译|
|Node 22.22.2+ 与已安装的 `node_modules`|`npm run build` 需要；依赖声明为 `latest`，**不要**跑裸 `npm install`|
|`rsync`、免密 `ssh`|`make deploy` 依赖两者|

目标机：

|要求|说明|
|---|---|
|Linux x86_64|产物是 `linux/amd64`。换架构见下文「产物架构不匹配」|
|systemd 用户服务可用|`systemctl --user` 能连上总线（会话里 `XDG_RUNTIME_DIR=/run/user/$(id -u)` 存在）。本手册的实例是 systemd 257|
|`Linger=yes`|`loginctl show-user <user> -p Linger` 必须是 `yes`，否则退出登录后服务会被停掉，开机自启也不成立。需要时 `sudo loginctl enable-linger <user>`|
|`/usr/share/zoneinfo/<家庭时区>`|家庭时区加载失败会让 `/health/ready` 一直 503|
|端口空闲|`ss -ltn "sport = :9080"` 无输出|
|磁盘余量|DB + 上传的照片/视频；本次部署时 `~/` 有 9.5G 可用|

不需要 root，也不需要放行防火墙（firewalld 未启用；若启用则需放行该端口）。

## 目录布局

远端（本手册的实例）：

```
/home/pengchang/growjoy/
├── bin/growjoy          # 交叉编译产物（0755，静态 linux/amd64）
├── dist/                # SPA 构建产物，rsync --delete 覆盖
│   ├── index.html
│   ├── assets/
│   └── fonts/fredoka.woff2
└── data/                # 0700，首次启动自动创建
    ├── growjoy.db       # SQLite（WAL）
    └── media/           # 上传的照片与视频
```

`~/.config/systemd/user/growjoy.service`：用户服务单元（下文）。

远端**不要**放源码、`node_modules`、`data/`（本地）或 `.git`。

## 首次部署

一次性的四步：构建 → 传输 → 建家庭 → 装服务。日常升级只需 `make deploy`。

### 1. 本地构建

```bash
npm run build
mkdir -p /tmp/growjoy-deploy
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -ldflags "-X main.version=$(git describe --always --dirty)" \
  -o /tmp/growjoy-deploy/growjoy ./cmd/growjoy
file /tmp/growjoy-deploy/growjoy
```

`file` 应报 `ELF 64-bit LSB executable, x86-64, statically linked`。记下 `git describe` 的输出，验证阶段要拿它和 `/health/live` 的 `version` 对照。

产物刻意放在 `/tmp`（或 `make deploy` 的 `DEPLOY_STAGE`）：仓库 `.gitignore` 没有 `growjoy` 条目，写进仓库会留下未跟踪文件。

### 2. 传输

```bash
ssh <host> 'mkdir -p ~/growjoy/bin ~/growjoy/dist'
rsync -a --delete -e ssh dist/ <host>:~/growjoy/dist/
rsync -a -e ssh /tmp/growjoy-deploy/growjoy <host>:~/growjoy/bin/growjoy
ssh <host> 'chmod +x ~/growjoy/bin/growjoy'
```

`--delete` 只能指向这个专属的 `dist/` 子目录。目的写成 `~` 或 `~growjoy/` 之外的家目录会把无关目录纳入比较与删除。

### 3. 建家庭（必须在起服务之前）

```bash
ssh <host> 'GROWJOY_DB=$HOME/growjoy/data/growjoy.db \
  GROWJOY_MEDIA=$HOME/growjoy/data/media \
  GROWJOY_DIST=$HOME/growjoy/dist \
  ~/growjoy/bin/growjoy admin create-family \
    --code HOME --name 我们的家 --username parent --display-name 家长 \
    --password 1357 --timezone Asia/Shanghai'
```

- 成功时无输出、退出码 0；`Open` 会自动以 0700 建好 `data/` 与 `data/media/` 并执行嵌入式迁移，所以不必先手动建目录。
- **不能省**：数据库里没有家庭时，`POST /auth/child` 返回 `409 no_family`，SPA 会停在无法进入的状态。
- `--password` 必须是正好 4 位数字（`validPin`），`--timezone` 必须是可加载的 IANA 名称，`--code`/`--name` 必填。
- 一个库只能有一个家庭：服务永远只服务 `families` 表里最旧的一行，第二次 `admin create-family` 会被直接拒绝。要多家庭就各自部署一套。
- 想灌演示数据（一个孩子、若干任务与愿望、十天历史）可加 `seed-demo --family HOME`；真实使用不必执行。

### 4. systemd 用户服务

`~/.config/systemd/user/growjoy.service`：

```ini
[Unit]
Description=GrowJoy 家庭成长任务服务
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/pengchang/growjoy
Environment=GROWJOY_ADDR=0.0.0.0:9080
Environment=GROWJOY_DB=/home/pengchang/growjoy/data/growjoy.db
Environment=GROWJOY_MEDIA=/home/pengchang/growjoy/data/media
Environment=GROWJOY_DIST=/home/pengchang/growjoy/dist
Environment=GROWJOY_SECURE_COOKIES=false
ExecStart=/home/pengchang/growjoy/bin/growjoy serve
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

```bash
ssh <host> 'systemctl --user daemon-reload && systemctl --user enable --now growjoy'
ssh <host> 'systemctl --user --no-pager status growjoy | head -20'
```

- 用**用户**服务：不需要 root，配合 `Linger=yes` 即可开机自启。不要写成系统级 unit。
- `GROWJOY_ADDR=0.0.0.0:9080` 是必需的：旗标默认只绑 `127.0.0.1:8080`，只绑回环则局域网访问不到。
- `serve` **不加** `--demo`：那会创建/更新演示家庭。
- `systemctl --user` 报 `Failed to connect to bus` 时，先在会话里 `export XDG_RUNTIME_DIR=/run/user/$(id -u)`。

启动日志应包含：

```
INFO serving family code=HOME
INFO GrowJoy listening addr=0.0.0.0:9080
```

## 日常升级：`make deploy`

```bash
make deploy
```

它按顺序做：`npm run build` → `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-X main.version=$(git describe --always --dirty)"` 到 `DEPLOY_STAGE` → 校验产物是 `x86-64` ELF → `ssh mkdir -p` → `rsync -a --delete` 覆盖 `dist/` → `rsync` 二进制 → `chmod +x` → `systemctl --user restart $(DEPLOY_UNIT)` → 轮询 `/health/ready`（最多 30 秒）→ 断言 `/health/live` 的 `version` 等于本地 `git describe`，不一致即退非零。

成功输出形如：

```
▶ 构建 SPA（dist/）与 linux/amd64 二进制（version=1c123d0）
▶ 传输 dist/ 与二进制到 rocky.home:/home/pengchang/growjoy
▶ 等待 http://192.168.0.208:9080/health/ready
{"status":"ok","version":"1c123d0"}
✔ 已部署并复检通过：http://192.168.0.208:9080 version=1c123d0
```

可覆盖的变量：

|变量|默认值|说明|
|---|---|---|
|`DEPLOY_HOST`|`rocky.home`|需免密 ssh 的目标|
|`DEPLOY_DIR`|`/home/pengchang/growjoy`|远端安装根目录|
|`DEPLOY_URL`|`http://192.168.0.208:9080`|必须是 `GROWJOY_ADDR` 实际监听的地址，用来自检|
|`DEPLOY_UNIT`|`growjoy`|systemd 用户单元名|
|`DEPLOY_STAGE`|`/tmp/growjoy-deploy`|交叉编译产物暂存目录（仓库之外）|

例：`make deploy DEPLOY_HOST=user@other DEPLOY_URL=http://other:9080 DEPLOY_DIR=/srv/growjoy`。

它**不**改远端 `data/`（数据库与上传文件原样保留）、不建家庭、不动 unit 文件。首次部署的前置准备仍需手工做一次。

## 配置项

只有 `cmd/growjoy/main.go` 读环境变量；空字符串按未设置处理。

|变量|默认|说明|
|---|---|---|
|`GROWJOY_ADDR`|`127.0.0.1:8080`|`serve` 的默认监听地址，也是 `--addr` 旗标的默认值|
|`GROWJOY_DB`|`data/growjoy.db`|SQLite 文件路径|
|`GROWJOY_MEDIA`|`data/media`|上传目录；`backup`/`gc` 也读它|
|`GROWJOY_DIST`|`dist`|SPA 目录；置空则不注册 SPA 兜底路由|
|`GROWJOY_SECURE_COOKIES`|`false`|必须**正好**是 `true` 才生效|

CLI：

|命令|用途|
|---|---|
|`growjoy serve [--addr] [--demo]`|主服务；`--demo` 会创建/更新演示家庭|
|`growjoy admin create-family --code --name --username --display-name --password --timezone`|建家庭（每库仅一次）|
|`growjoy seed-demo [--family DEMO]`|为指定家庭幂等生成演示内容|
|`growjoy backup --out <dir>`|一致性快照到目录（可在线执行，拒绝覆盖）|
|`growjoy gc --media [--delete] [--force]`|清理没有附件记录引用的媒体文件|

### 明文 HTTP 直连 vs 反向代理

直连 `IP:端口`（本手册的形态）时：

- 必须 `GROWJOY_ADDR=0.0.0.0:<port>`。
- 必须 `GROWJOY_SECURE_COOKIES=false`。设为 `true` 时浏览器不会在明文 HTTP 下回传 `growjoy_session`，每个请求都会重开会话，表现为「点什么都像被登出」。
- 不需要处理跨域：浏览器发出的 `Host` 与 `Origin` 天然同源。

套反向代理 + TLS 时：

- 代理**必须保留浏览器发送的 `Host`**（nginx：`proxy_set_header Host $host`）。写接口校验 `Origin` 与 `r.Host` 同源，Host 被改写成上游地址时所有写请求都会 `403 origin_mismatch`。开发用的 Vite 代理就是为此设了 `changeOrigin: false`。
- 该场景下把 `GROWJOY_SECURE_COOKIES=true`。
- `403 cross_site_request` 来自 `Sec-Fetch-Site: cross-site`，同样说明代理或前端域名配错了。

## 运行与观测

```bash
# 存活与版本（version 来自 -ldflags "-X main.version=..."，未注入时为 dev）
curl -sS http://192.168.0.208:9080/health/live
# {"status":"ok","version":"1c123d0"}

# 就绪：数据库可答 + 所服务家庭的时区能加载，否则 503
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.0.208:9080/health/ready

# 自启与运行状态
ssh rocky.home 'systemctl --user is-enabled growjoy; systemctl --user is-active growjoy; loginctl show-user pengchang -p Linger'

# 日志
ssh rocky.home 'systemctl --user status growjoy -n 50'      # 跟随时加 -f
ssh rocky.home 'sudo journalctl _SYSTEMD_USER_UNIT=growjoy.service -n 50 --no-pager'
```

日志注意：这台主机**没有用户级 journal 文件**，`journalctl --user -u growjoy` 只会返回 `No journal files were found`。用 `systemctl --user status growjoy`（即 systemd 直接输出的那几行）或上面的 `_SYSTEMD_USER_UNIT=` 形式。启动日志里 `INFO serving family code=...` 说明本次实际服务的家庭码。

`serve` 在启动时以及此后每小时清理一次过期会话与超过 30 天的幂等键，不需要外部 cron。限流状态在内存里，重启即清零。

## 备份与恢复

```bash
ssh rocky.home 'GROWJOY_DB=$HOME/growjoy/data/growjoy.db \
  GROWJOY_MEDIA=$HOME/growjoy/data/media \
  ~/growjoy/bin/growjoy backup --out $HOME/growjoy/backup-$(date +%F)'
```

用 `VACUUM INTO` 取数据库一致性快照，再打包媒体目录，因此**可以在服务运行时执行**。目录里已存在 `growjoy.db` 或 `media.tar` 时会拒绝覆盖，换一个目录即可。输出包含 `growjoy.db` 与 `media.tar` 两个文件，两者必须一起保存。

恢复（备份文件就在同一台主机上，直接在远端替换即可）：

```bash
ssh rocky.home 'systemctl --user stop growjoy'
ssh rocky.home 'set -e; cd $HOME/growjoy; cp backup-2026-10-02/growjoy.db data/growjoy.db; \
  rm -f data/growjoy.db-wal data/growjoy.db-shm; \
  tar -C data/media -xf backup-2026-10-02/media.tar'
ssh rocky.home 'systemctl --user start growjoy'
```

恢复期间先停服务再替换文件，避免进程继续写入。`rm -f` 那一步是兜底：`systemctl --user stop` 会给 SQLite 收尾，实测停服后 `-wal`/`-shm` 已自行消失；只有在进程被强杀（OOM、`kill -9`）时才可能留下残留文件。残留本身不会污染数据——实测把另一份数据库的 `-wal` 放在替换后的库旁边，服务照常启动、返回的是替换后库的内容、日志无报错（SQLite 会忽略不属于当前库的 WAL）——删掉只是为了不留没用的旧文件。随后的 `/health/ready` 返回 200 即恢复完成。本手册的实例**没有配置任何定时备份**，需要就自己加 cron 或 systemd timer。

媒体清理（孩子或任务删除后可能留下没有附件记录引用的孤儿文件）：

```bash
~/growjoy/bin/growjoy gc --media           # 只列出
~/growjoy/bin/growjoy gc --media --delete  # 真正删除
```

数据库里一条附件记录都没有时它拒绝删除（通常意味着 `GROWJOY_DB` 指错了库），确认无误后加 `--force`。

## 排错

|症状|原因与处理|
|---|---|
|`exec format error`，或启动即退出|产物架构不匹配。本机重新构建并改正 `GOARCH`；或在目标机上用它的 Go 直接 `CGO_ENABLED=0 go build -o ~/growjoy/bin/growjoy ./cmd/growjoy`（需要源码，前端仍可用本地 `dist/`）|
|`journalctl` 出现 `address already in use`|端口被占。改 unit 里的 `GROWJOY_ADDR` **和** `DEPLOY_URL`（先用 `ss -ltn "sport = :<port>"` 确认为空），再 `daemon-reload` + `restart`|
|`/health/ready` 一直 503，日志无异常|两类原因：数据库打不开（路径/权限），或家庭时区加载不了（`/usr/share/zoneinfo` 缺该时区）。响应体只有 `unavailable`，细节在启动日志里|
|每个请求都像被登出、反复跳孩子端|`GROWJOY_SECURE_COOKIES=true` 但走的是明文 HTTP。改回 `false`|
|所有写请求 `403 origin_mismatch`|前面有代理改写了 `Host`，或前端页面与 API 不同源|
|页面白屏、样式或脚本 404|`dist/` 没同步或 `GROWJOY_DIST` 指错。注意 `spaHandler` 对未知路径返回 `index.html` 200，坏引用是静默失败，不会 404|
|改了 `src/` 但页面不变|服务端只发 `dist/` 里的内容，没有 HMR。必须 `npm run build` 后重传（`make deploy` 已包含）|
|`429 too_many_requests`|认证限流：按客户端地址 60 次突发/每秒 1 次；按家庭家长密码失败 10 次后每 30 秒恢复 1 次。**只有失败才消耗家庭额度**，所以输错密码不会锁死家长端|
|`503 unavailable`（argon2）|并发校验槽位（4 个，每个 64 MiB）被占满。稍后重试|

## 安全边界

- **只放在内网或 Tailscale 内，不要映射到公网。** 手册中的实例是明文 HTTP + 4 位家长 PIN，没有 TLS；孩子端无凭据，能打开页面的人就能看到任务、提交证据、兑换愿望。要暴露到公网请加反向代理与 TLS，并把 `GROWJOY_SECURE_COOKIES` 改为 `true`。
- 家长密码可在家长端右上角菜单「修改家长密码」改成任意 4 位数字；改密码会重写该家庭所有 `parents` 行，但不会踢掉当前已打开的家长端。
- 备份文件含全部家庭数据与孩子上传的照片/视频，和数据库同等敏感。
