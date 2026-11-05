# GrowJoy 常用命令。运行 `make` 或 `make help` 查看全部目标。
SHELL := /bin/bash
.DEFAULT_GOAL := help

DEV_LOG := data/dev-server.log
DEV_BIN := data/growjoy-dev

# 部署（make deploy）的目标：本机就是目标机（192.168.0.208），所以经 localhost 自 ssh，
# 本机公钥需在 ~/.ssh/authorized_keys 里；DEPLOY_URL 必须指向 GROWJOY_ADDR 实际监听的地址。
DEPLOY_HOST ?= localhost
DEPLOY_DIR ?= /home/pengchang/growjoy
DEPLOY_URL ?= http://192.168.0.208:9080
DEPLOY_UNIT ?= growjoy
DEPLOY_STAGE ?= /tmp/growjoy-deploy
# 交互式部署允许 ssh 自己问密码/口令；CI 里通过环境变量覆盖成 BatchMode。
SSH_OPTS ?= -o ConnectTimeout=10

.PHONY: help install build dev server web run preview vet fmt test test-go test-web check check-flow check-ui precommit install-hooks deploy logs stop clean distclean

help: ## 显示全部可用命令
	@echo "GrowJoy 可用命令："
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## 安装前端依赖（npm install；依赖声明为 latest，注意会刷新锁文件）
	npm install

build: ## 类型检查并构建 SPA 到 dist/
	npm run build

dev: ## 一键启动后端(:8080) + 前端(:5173)，Ctrl-C 一并退出
	@mkdir -p data
	@command -v npm >/dev/null 2>&1 || { echo "✗ 未找到 npm：需要 Node.js 22.22.2+（如 brew install node）"; exit 1; }
	@[ -d node_modules ] || { echo "✗ 依赖未安装，先运行: make install"; exit 1; }
	@if lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "✗ 127.0.0.1:8080 已被占用：Vite 代理硬编码指向它（vite.config.mjs）"; \
	  echo "  查看占用者:  lsof -nP -iTCP:8080 -sTCP:LISTEN"; \
	  echo "  清理残留:    make stop"; \
	  exit 1; \
	fi
	@echo "▶ 后端  http://127.0.0.1:8080   （serve --demo，日志 $(DEV_LOG)）"
	@echo "▶ 前端  http://localhost:5173   ← 打开这个地址（Vite 监听 ::1，用 localhost 而非 127.0.0.1）"
	@go build -o $(DEV_BIN) ./cmd/growjoy
	@$(DEV_BIN) serve --demo >$(DEV_LOG) 2>&1 & \
	server_pid=$$!; \
	trap 'kill $$server_pid 2>/dev/null; wait $$server_pid 2>/dev/null' EXIT INT TERM; \
	npm run dev

server: ## 只启动后端（:8080，serve --demo）
	npm run dev:server

web: ## 只启动前端 Vite（:5173，需后端已在 8080 运行）
	npm run dev

run: build ## 构建后用 Go 单进程服务 dist/（:8080）
	@echo "▶ http://127.0.0.1:8080"
	@go run ./cmd/growjoy serve --demo

preview: build ## 静态预览 dist/（无 /api 代理，只看样式）
	npm run preview

vet: ## go vet ./...
	go vet ./...

fmt: ## gofmt 格式化 Go 代码
	gofmt -l -w cmd internal

test: vet test-go test-web ## 后端 + 前端单元测试

test-go: ## Go 测试（-race，与 CI 一致）
	go test -race ./...

test-web: ## 前端单元测试（vitest）
	npm test

check: test check-flow check-ui ## 完整检查（vet/test/build + 两个 Playwright 门）

check-flow: ## Playwright 行为门（自带 build，需先装 Chromium）
	npm run check:flow

check-ui: ## Playwright 视觉/溢出门（自带 build）
	npm run check:ui

precommit: test build ## 提交前快速门（vet + go test -race + npm test + build，不含两个 Playwright 门）

install-hooks: ## 安装提交前钩子（.githooks/pre-commit → make precommit）
	git config core.hooksPath .githooks
	@echo "✔ 已启用 .githooks/pre-commit（提交前跑 make test build）"

deploy: ## 部署新版本到远程主机：构建 SPA + 交叉编译 linux/amd64 + rsync + 重启用户服务 + 健康校验（校验失败自动回滚）
	@command -v npm >/dev/null 2>&1 || { echo "✗ 未找到 npm：需要 Node.js 22.22.2+"; exit 1; }
	@[ -d node_modules ] || { echo "✗ 依赖未安装，先运行: make install"; exit 1; }
	@set -euo pipefail; \
	STAGE=$$(mktemp -d "$(DEPLOY_STAGE).XXXXXX"); \
	SWAPPED=0; \
	rollback() { \
	  [ "$$SWAPPED" = "1" ] || return 0; \
	  echo "▶ 校验未通过，回滚到上一版"; \
	  ssh $(SSH_OPTS) $(DEPLOY_HOST) 'if [ -f $(DEPLOY_DIR)/bin/growjoy.prev ]; then mv -f $(DEPLOY_DIR)/bin/growjoy.prev $(DEPLOY_DIR)/bin/growjoy; fi; if [ -d $(DEPLOY_DIR)/dist.prev ]; then rm -rf $(DEPLOY_DIR)/dist && mv $(DEPLOY_DIR)/dist.prev $(DEPLOY_DIR)/dist; fi; systemctl --user restart $(DEPLOY_UNIT)' || true; \
	}; \
	cleanup() { STATUS=$$?; rollback; rm -rf "$$STAGE"; exit $$STATUS; }; \
	trap cleanup EXIT; \
	VERSION=$$(git describe --always --dirty); \
	echo "▶ 构建 SPA（dist/）与 linux/amd64 二进制（version=$${VERSION}）"; \
	npm run build; \
	[ -f dist/index.html ] || { echo "✗ dist/index.html 缺失：SPA 没有构建出来（spaHandler 对任何路径都回 index.html，缺了也不会 404）"; exit 1; }; \
	ASSET=$$(grep -o 'assets/[^"]*\.js' dist/index.html | head -1); \
	[ -n "$$ASSET" ] || { echo "✗ dist/index.html 里没有入口 JS 引用"; exit 1; }; \
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-X main.version=$${VERSION}" -o "$$STAGE/growjoy" ./cmd/growjoy; \
	file "$$STAGE/growjoy" | grep -q 'ELF 64-bit.*x86-64' || { echo "✗ 产物不是 linux/amd64 ELF"; exit 1; }; \
	echo "▶ 传输 dist/ 与二进制到 $(DEPLOY_HOST):$(DEPLOY_DIR)"; \
	ssh $(SSH_OPTS) $(DEPLOY_HOST) 'mkdir -p $(DEPLOY_DIR)/bin $(DEPLOY_DIR)/dist; rm -rf $(DEPLOY_DIR)/bin/growjoy.prev $(DEPLOY_DIR)/dist.prev; if [ -f $(DEPLOY_DIR)/bin/growjoy ]; then cp -p $(DEPLOY_DIR)/bin/growjoy $(DEPLOY_DIR)/bin/growjoy.prev; fi; if [ -d $(DEPLOY_DIR)/dist ]; then cp -a $(DEPLOY_DIR)/dist $(DEPLOY_DIR)/dist.prev; fi'; \
	rsync -a --delete -e "ssh $(SSH_OPTS)" dist/ $(DEPLOY_HOST):$(DEPLOY_DIR)/dist/; \
	rsync -a -e "ssh $(SSH_OPTS)" "$$STAGE/growjoy" $(DEPLOY_HOST):$(DEPLOY_DIR)/bin/growjoy; \
	ssh $(SSH_OPTS) $(DEPLOY_HOST) 'chmod +x $(DEPLOY_DIR)/bin/growjoy && systemctl --user restart $(DEPLOY_UNIT)'; \
	SWAPPED=1; \
	echo "▶ 等待 $(DEPLOY_URL)/health/ready"; \
	CODE=; \
	for i in $$(seq 1 60); do \
	  CODE=$$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$(DEPLOY_URL)/health/ready" 2>/dev/null || true); \
	  if [ "$$CODE" = "200" ]; then break; fi; \
	  sleep 0.5; \
	done; \
	if [ "$$CODE" != "200" ]; then echo "✗ /health/ready 未就绪（HTTP $${CODE:-无响应}）：ssh $(DEPLOY_HOST) 'systemctl --user status $(DEPLOY_UNIT)'"; exit 1; fi; \
	LIVE=$$(curl -sS --max-time 5 "$(DEPLOY_URL)/health/live"); \
	echo "$$LIVE"; \
	case "$$LIVE" in \
	  *"\"version\":\"$${VERSION}\""*) ;; \
	  *) echo "✗ 远端版本与本次构建不一致（期望 $${VERSION}）"; exit 1;; \
	esac; \
	# 同一个 commit 重复部署时 version 字符串不变，光看它分不清新进程与旧进程；\
	# SPA 入口要真的指向这次构建出来的那个 JS 产物，才算这轮 dist/ 上线了（入口从\
	# index.html 解析，不再靠「assets 目录里第一个 js」，拆分 chunk 后也不会认错）。\
	SERVED=$$(curl -sS --max-time 5 "$(DEPLOY_URL)/" | grep -o 'assets/[^"]*\.js' | head -1); \
	if [ "$$SERVED" != "$$ASSET" ]; then echo "✗ 首页仍在引用 $${SERVED:-（无）}（期望 $$ASSET）：dist/ 可能没落盘或缓存未清"; exit 1; fi; \
	ssh $(SSH_OPTS) $(DEPLOY_HOST) 'rm -rf $(DEPLOY_DIR)/bin/growjoy.prev $(DEPLOY_DIR)/dist.prev'; \
	echo "✔ 已部署并复检通过：$(DEPLOY_URL) version=$${VERSION} asset=$$ASSET"

logs: ## 跟随后端开发日志
	tail -f $(DEV_LOG)

stop: ## 停止占用 :8080 的进程（make dev 的残留后端）
	@lsof -nP -tiTCP:8080 -sTCP:LISTEN | xargs kill 2>/dev/null || true
	@echo "✔ 已请求停止 :8080 上的进程（原本无进程时为空操作）"

clean: ## 删除构建产物（dist、截图、tsbuildinfo、开发日志）
	rm -rf dist .artifacts
	rm -f *.tsbuildinfo $(DEV_LOG) $(DEV_BIN)
	@echo "✔ 已清理构建产物"

distclean: ## 危险：连同 data/（本地 SQLite 与上传媒体）一起删除
	@read -r -p "将删除 data/（本地数据库与上传文件）及全部构建产物，确认？[y/N] " ok; \
	if [ "$$ok" != "y" ]; then echo "已取消"; exit 1; fi; \
	rm -rf dist .artifacts data; \
	rm -f *.tsbuildinfo; \
	echo "✔ 已重置为全新工作区（依赖仍在，可 make install）"
