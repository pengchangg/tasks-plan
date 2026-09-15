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
  await page.goto(`${baseUrl}/child`, { waitUntil: "networkidle" });
  await page.getByLabel("孩子 PIN").fill("2468");
  await page.getByRole("button", { name: "进入成长空间" }).click();
  await page.locator(".bottom-nav").waitFor();
  if (scenario.path.startsWith("/parent")) {
    await page.locator(".profile-button").click();
    await page
      .locator(".role-menu")
      .getByRole("button", { name: /家长端/ })
      .click();
    const modal = page.locator(".pin-modal");
    await modal.getByLabel("家长密码").fill("growjoy2468");
    await modal.getByRole("button", { name: "验证并进入" }).click();
    await page.waitForURL(/\/parent$/);
  }
  await page.goto(`${baseUrl}${scenario.path}`, { waitUntil: "networkidle" });
  await page
    .locator(
      scenario.path.startsWith("/parent") ? ".parent-layout" : ".bottom-nav",
    )
    .waitFor();
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
