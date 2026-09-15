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

## 验证

```bash
go test ./...
npm test
npm run build
npm run check:flow
npm run check:ui
```

两个 Playwright 命令会各自创建临时 SQLite 数据库和媒体目录、选择动态端口、启动真实 Go 服务，并在结束时清理。
