import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const outputDir = ".artifacts/ui";
const scenarios = [
  { name: "child-375", path: "/child", width: 375, height: 812 },
  { name: "child-390", path: "/child/tasks", width: 390, height: 844 },
  { name: "parent-mobile", path: "/parent", width: 390, height: 844 },
  {
    name: "tasks-mobile",
    path: "/parent/tasks",
    width: 375,
    height: 812,
  },
  {
    name: "wishes-mobile",
    path: "/parent/wishes",
    width: 390,
    height: 844,
  },
  {
    name: "children-mobile",
    path: "/parent/children",
    width: 390,
    height: 844,
  },
  { name: "parent-desktop", path: "/parent/stats", width: 1440, height: 1000 },
  {
    name: "tasks-desktop",
    path: "/parent/tasks",
    width: 1440,
    height: 1000,
  },
  {
    name: "children-desktop",
    path: "/parent/children",
    width: 1440,
    height: 1000,
  },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
let failed = false;

for (const scenario of scenarios) {
  const page = await browser.newPage({
    viewport: { width: scenario.width, height: scenario.height },
  });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  if (scenario.path.startsWith("/parent")) {
    await page.addInitScript(() =>
      sessionStorage.setItem("growjoy-parent-unlocked", "1"),
    );
  }

  await page.goto(`${baseUrl}${scenario.path}`, { waitUntil: "networkidle" });
  const layout = await page.evaluate(() => ({
    title: document.title,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    bodyHeight: document.body.scrollHeight,
    textLength: document.body.innerText.trim().length,
  }));
  await page.screenshot({
    path: `${outputDir}/${scenario.name}.png`,
    fullPage: true,
  });

  const overflow = layout.bodyWidth > layout.viewportWidth + 1;
  const invalid =
    errors.length > 0 ||
    overflow ||
    layout.textLength < 20 ||
    layout.bodyHeight < scenario.height / 2;
  failed ||= invalid;
  console.log(
    JSON.stringify({ scenario: scenario.name, ...layout, overflow, errors }),
  );
  await page.close();
}

await browser.close();
if (failed) process.exitCode = 1;
