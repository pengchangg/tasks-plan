# GrowJoy 小小成长家

[![部署状态](https://gitea.homelab.com/pengchang/task-plan/actions/workflows/deploy.yml/badge.svg?branch=main)](https://gitea.homelab.com/pengchang/task-plan/actions)

面向家庭的成长任务与积分奖励 H5。家长发布任务、作业和愿望，孩子完成任务换取积分，积分再兑换愿望。一个 Go 二进制同源提供 JSON API、会话认证、受保护的上传文件和预构建的 React 前端，全部状态就是**一份 SQLite 文件 + 一个媒体目录**。

## 快速开始

要求 Go 1.22+、Node.js 22.22.2+，并已安装 Playwright Chromium（只有跑 E2E 门时需要）。

```bash
npm install
make dev          # 一个命令起后端 :8080 + 前端 :5173，Ctrl-C 一并退出
```

打开 `http://localhost:5173`（Vite 监听 `::1`，用 `localhost` 而不是 `127.0.0.1`）。也可以分两个终端跑 `npm run dev:server` 和 `npm run dev`。`make` / `make help` 会列出全部常用目标。

演示账号（`serve --demo` 幂等创建）：

- 孩子端：打开即用，没有登录步骤
- 家长端：`/parent`，家长密码 `2468`
- 演示数据：一个孩子「米娅」、4 个任务、4 个愿望，外加十天历史记录

## 功能

| 孩子端 | 家长端 |
|---|---|
| 查看今日任务与作业，一键完成任务 | 管理孩子、任务、愿望，审批提交并发放积分 |
| 查看积分余额、等级与连续打卡天数 | 手动增减积分（记账到同一本积分账本） |
| 兑换愿望，标记完成并补充证据 | 发布每日作业（图片自动压缩、按日期查看） |
| 成长日历：每天的任务、补录记录与成长汇总 | 成长统计：按自定义日期区间看完成量与积分 |

## 用户模型

- **一个部署服务一个家庭**：服务永远读取数据库里最早创建的那一行家庭，客户端不再输入家庭码；需要多个家庭请分别部署。库为空时孩子端会返回 `409 no_family`，用 `admin create-family` 建家庭。
- **孩子端是默认界面**：能打开页面的人都能看到任务、完成任务、兑换愿望——这是家庭局域网的信任模型。
- **家长密码是 4 位数字**，只保护家长端。它可以随时在账号菜单里修改（需要当前密码），修改后旧密码立即失效。家长权限只属于本次访问：刷新页面会回到孩子端，要重新输入密码。
- **写操作都校验同源**：`Origin` 的 host 必须等于请求的 `Host`，所以反向代理必须保留浏览器发来的 `Host`。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构、目录、请求链路、数据流、一致性约束、时区与统计规则 |
| [docs/api.md](docs/api.md) | HTTP 接口参考：认证、全部路由、请求体、错误码、幂等与上传限制 |
| [docs/development.md](docs/development.md) | 本地开发、命令表、代码约定、测试与提交门禁、常见坑 |
| [docs/operations.md](docs/operations.md) | 生产运行、环境变量、限流与安全边界、健康检查、备份与清理 |
| [android/README.md](android/README.md) | 安卓 APK（WebView 壳）：`./android/build.sh` 本地出包、地址配置、墙内换源 |
| [DEPLOY.md](DEPLOY.md) | 远程部署手册：首次部署、systemd、反向代理 / Caddy / Cloudflare 隧道、排错 |

## 技术栈与目录

Go 1.22 + chi + 纯 Go 的 `modernc.org/sqlite`（无 cgo）；React 19 + Vite + TypeScript（strict）；样式是手写 CSS，图标来自 `lucide-react`，字体（Fredoka、霞鹜文楷 GB）全部自托管，页面不请求任何第三方域名。

```
cmd/growjoy/                 唯一入口：serve | admin create-family | seed-demo | backup | gc
internal/server/             整个后端：路由、处理器、认证、上传、统计
internal/server/migrations/  嵌入式 SQL 迁移
src/                         单页应用：App.tsx（全部界面）、store.ts（状态与 API 客户端）等
scripts/                     Playwright 校验脚本（flow-check / visual-check / with-service）
docs/                        架构、接口、开发与运维文档
public/                      图标与自托管字体
dist/                        Vite 产物，由 Go 服务；构建后才有
```

## 验证与发布

```bash
make precommit    # 快速门：go vet + go test -race + vitest + 构建（提交前钩子同此）
make check        # 完整门：单元测试 + 两个 Playwright 门
make deploy       # 构建 + 交叉编译 + rsync + 重启远端服务 + 健康校验
```

推送到 `main` 后由 Gitea Actions 自动跑 `make precommit` 再执行 `make deploy`；两个 Playwright 门不进入 CI，按需手动跑。首次部署与反向代理配置见 [DEPLOY.md](DEPLOY.md)。
