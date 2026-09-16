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
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

let service = null;
let serviceExited = null;

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) break;
    } catch {}
    if (attempt === 99) throw new Error("GrowJoy service did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await run(process.execPath, [target], {
    env: { ...process.env, BASE_URL: baseUrl },
  });
} finally {
  service?.kill("SIGTERM");
  if (serviceExited) await serviceExited;
  await rm(temp, { recursive: true, force: true });
}
