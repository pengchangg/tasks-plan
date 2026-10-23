import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const outputDir = ".artifacts/ui";
const scenarios = [
  { name: "child-375", path: "/child", width: 375, height: 812 },
  { name: "child-390", path: "/child/tasks", width: 390, height: 844 },
  { name: "homework-390", path: "/child/homework", width: 390, height: 844 },
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
    name: "homework-desktop",
    path: "/parent/homework",
    width: 1440,
    height: 1000,
  },
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
  { name: "growth-375", path: "/child/growth", width: 375, height: 812 },
  { name: "growth-390", path: "/child/growth", width: 390, height: 844 },
];

const childLinks = {
  "/child": null,
  "/child/tasks": "任务",
  "/child/homework": "作业",
  "/child/growth": "成长",
};

const parentLinks = {
  "/parent": null,
  "/parent/children": "孩子管理",
  "/parent/tasks": "任务管理",
  "/parent/wishes": "愿望管理",
  "/parent/homework": "作业管理",
  "/parent/stats": "成长统计",
};

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
  // The child end is the default view; /parent is a password-gated detour.
  await page.locator(".bottom-nav").waitFor();
  const parent = scenario.path.startsWith("/parent");
  if (parent) {
    await page.locator(".profile-button").click();
    await page
      .locator(".role-menu")
      .getByRole("button", { name: /家长端/ })
      .click();
    const modal = page.locator(".pin-modal");
    await modal.getByLabel("家长密码").fill("2468");
    await modal.getByRole("button", { name: "验证并进入" }).click();
    await page.waitForURL(/\/parent$/);
    // Move inside the app: a reload would land back in the child end, which
    // is exactly what the password gate is for.
    const link = parentLinks[scenario.path];
    if (link) await page.getByRole("link", { name: link }).click();
    else if (scenario.path !== "/parent")
      throw new Error(`no sidebar link for ${scenario.path}`);
  } else {
    // same route walk on the child end; exact names because the brand link
    // 小小成长家 contains 成长 as a substring.
    const link = childLinks[scenario.path];
    if (link)
      await page.getByRole("link", { name: link, exact: true }).click();
    else if (scenario.path !== "/child")
      throw new Error(`no bottom-nav link for ${scenario.path}`);
  }
  // Navigation that neither moves nor lands wrongly would still screenshot a
  // plausible screen, so the URL is part of the gate.
  await page.waitForURL(new RegExp(`${scenario.path}$`));
  await page
    .locator(parent ? ".parent-layout" : ".bottom-nav")
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

  // 作业表单是假期预填的入口：起止日期都得在、范围不能倒置，弹窗自己不能横向溢出。
  if (scenario.name === "homework-desktop") {
    await page.getByRole("button", { name: "新增作业" }).click();
    const form = page.locator(".form-modal");
    await form.waitFor();
    const range = {
      start: await form.getByLabel("日期", { exact: true }).inputValue(),
      end: await form.getByLabel("结束日期").inputValue(),
    };
    const box = await form.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    if (
      !range.start ||
      !range.end ||
      range.end < range.start ||
      box.scrollWidth > box.clientWidth + 1
    )
      errors.push(
        `homework form range ${range.start}..${range.end} scrollWidth=${box.scrollWidth}`,
      );
    await form.locator(".form-heading button").click();
    await form.waitFor({ state: "detached" });
  }

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
