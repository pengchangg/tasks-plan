# GrowJoy 常用命令。运行 `make` 或 `make help` 查看全部目标。
SHELL := /bin/bash
.DEFAULT_GOAL := help

DEV_LOG := data/dev-server.log
DEV_BIN := data/growjoy-dev

.PHONY: help install build dev server web run preview vet fmt test test-go test-web check check-flow check-ui logs stop clean distclean

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

check: test check-flow check-ui ## 完整 CI 门（含两个 Playwright 门）

check-flow: ## Playwright 行为门（自带 build，需先装 Chromium）
	npm run check:flow

check-ui: ## Playwright 视觉/溢出门（自带 build）
	npm run check:ui

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
