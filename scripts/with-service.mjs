import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: node scripts/with-service.mjs <script>");
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "growjoy-e2e-"));
const binary = join(temp, "growjoy");
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });
    active = child;
    child.on("error", reject);
    child.on("exit", (code) => {
      if (active === child) active = null;
      return code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code}`));
    });
  });
}

let service = null;
let serviceExited = null;
let serviceExit = null;
// 当前跑着的那一步（go build / 门脚本本身）。终端 Ctrl-C 会发给整个前台进程组，
// 但被 npm 或 CI 单独 signal 时只到这一层，子进程会变成孤儿。
let active = null;

async function cleanup() {
  active?.kill("SIGTERM");
  service?.kill("SIGTERM");
  if (serviceExited) await serviceExited;
  await rm(temp, { recursive: true, force: true });
}

// Ctrl-C 直接杀的是这一层：finally 只在脚本正常结束/抛出时才跑，收到 SIGINT 时
// 进程会立刻退出，临时目录里那个 serve 就会留在后台。
let signalled = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (signalled) return;
    signalled = true;
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  // Inside the try so a failed build still runs the finally block below, which
  // is the only thing that removes the temp directory.
  await run("go", ["build", "-o", binary, "./cmd/growjoy"]);
  service = spawn(
    binary,
    ["serve", "--demo", "--addr", `127.0.0.1:${port}`],
    {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        GROWJOY_DB: join(temp, "growjoy.db"),
        GROWJOY_MEDIA: join(temp, "media"),
        GROWJOY_DIST: join(root, "dist"),
      },
    },
  );
  serviceExited = new Promise((resolve) => service.once("exit", resolve));
  service.once("exit", (code, signal) => {
    serviceExit = signal ?? code;
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) break;
    } catch {}
    // 端口是「探测时空闲」而不是「已占住」：别人抢到就会连上别人的服务，
    // 自己的 serve 则因为 bind 失败直接退出。那两种情况下再等 10 秒也不会好，
    // 而且后续断言会在一个陌生服务上跑。
    if (serviceExit !== null)
      throw new Error(
        `GrowJoy service exited before ready (${serviceExit}) — 端口 ${port} 上可能已有别的进程`,
      );
    if (attempt === 99) throw new Error("GrowJoy service did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await run(process.execPath, [target], {
    env: { ...process.env, BASE_URL: baseUrl },
  });
} catch (error) {
  // 信号自己接管了退出：被我们杀掉的那步子进程不算门失败，别再抛一次栈。
  if (!signalled) throw error;
} finally {
  // 已在信号处理里清过也不算重复：kill 一个已退出的进程是空操作，
  // rm -f 是幂等的，serviceExited 也早已 resolve。
  await cleanup();
}
