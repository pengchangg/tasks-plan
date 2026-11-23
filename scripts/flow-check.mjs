import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4173";
await mkdir(".artifacts/ui", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
// A 401 is logged as a console error, and exactly two situations produce one:
// the deliberate wrong credentials (two PIN attempts and one wrong current
// password) and the probe enterChild() makes while its POST /auth/child is still
// in flight, which can carry the session that call just demoted. Both windows
// are opened explicitly below, so a logged-in read that regresses to 401 still
// fails the run.
let expectAuth401 = false;
let expectSwitch401 = false;
// 华容道那一幕会用 page.evaluate 直接打三个非法完成请求（低于最短解的步数、跳过
// 未通关的关卡、不存在的关卡），4xx 同样会被记成 console error；只有探针窗口内、
// 且 URL 确实是这条完成路由时才放行，别处冒出来的 4xx 照样让门禁失败。
let expectKlotskiProbe = false;
// 题类那一幕同样用 page.evaluate 直接打非法上报（没带幂等键、分数超量表、猜错
// 的第三个游戏），窗口内只放行这条上报路由的 4xx。
let expectQuizProbe = false;
function expected401(url) {
  if (expectAuth401 && url.endsWith("/api/v1/auth/parent")) return true;
  if (expectAuth401 && url.endsWith("/api/v1/auth/parent/password")) return true;
  return expectSwitch401 && url.endsWith("/api/v1/state");
}
function collectErrors(target) {
  target.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      message.text().includes("401 (Unauthorized)") &&
      expected401(message.location()?.url ?? "")
    )
      return;
    if (
      expectKlotskiProbe &&
      /\/api\/v1\/games\/klotski\/[^/]+\/complete$/.test(message.location()?.url ?? "")
    )
      return;
    if (
      expectQuizProbe &&
      /\/api\/v1\/games\/quizzes\/[^/]+\/score$/.test(message.location()?.url ?? "")
    )
      return;
    errors.push(message.text());
  });
  target.on("pageerror", (error) => errors.push(error.message));
}
collectErrors(page);

async function openChildEnd() {
  // The child end is the default view: no login screen, no credential.
  await page.locator(".bottom-nav").waitFor();
}
async function switchChild(name = "米娅") {
  await page.locator(".profile-button").click();
  await page
    .locator(".role-menu")
    .getByRole("button", { name: new RegExp(name) })
    .click();
  await waitForState(
    (s) => s.children.find((c) => c.id === s.activeChildId)?.name === name,
  );
}
async function getState() {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/state");
    return response.ok ? response.json() : null;
  });
}
// naturalWidth stays 0 until the browser has decoded the served bytes, and
// decode() rejects outright when the media route hands back something that is
// not a decodable image.
async function assertRealImage(image, width) {
  await image.waitFor();
  await image.evaluate((node) => node.decode());
  assert.equal(await image.evaluate((node) => node.naturalWidth), width);
}
async function waitForState(predicate) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await getState();
    if (state && predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out waiting for server state");
}
// 到账游标落在服务端（children.rewardsSeenAt）：每次文档加载都会把「还没庆祝过」
// 的到账按顺序补发一遍，所以除了专门断言那批横幅的场景，每处 goto/reload 之后都先
// 把它弹完再说，免得飘到后面的断言上。加载后先给 500ms 安静时间，再逐条关。
async function settleRewards() {
  const banner = page.locator(".reward-celebration");
  let quiet = 0;
  for (let attempt = 0; attempt < 80 && quiet < 20; attempt += 1) {
    if (await banner.count()) {
      quiet = 0;
      await banner.getByRole("button", { name: "关闭积分到账提示" }).click();
      await banner.waitFor({ state: "detached" });
      continue;
    }
    quiet += 1;
    await page.waitForTimeout(50);
  }
}
const cursorOf = (state, name = "米娅") =>
  state.children.find((child) => child.name === name).rewardsSeenAt;
// 同一标题在状态里可能有多个实例：种子带十天历史，真实部署也会按天累计。断言要的
// 始终是「当前这一个」——日任务的今天、周任务的本周那天——所以按 due_date 取最新的。
function currentTask(state, title) {
  return state.tasks
    .filter((task) => task.title === title)
    .sort((left, right) => right.dueDate.localeCompare(left.dueDate))[0];
}
async function unlockParent(
  checkError = false,
  url = /\/parent$/,
  password = "2468",
  rejected = "0000",
) {
  const modal = page.locator(".pin-modal");
  await modal.waitFor();
  const input = modal.getByLabel("家长密码");
  if (checkError) {
    expectAuth401 = true;
    await input.fill(rejected);
    await modal.getByRole("button", { name: "验证并进入" }).click();
    await modal.getByText("密码不正确，请重新输入").waitFor();
    expectAuth401 = false;
  }
  await input.fill(password);
  await modal.getByRole("button", { name: "验证并进入" }).click();
  await page.waitForURL(url);
}
async function enterParent(
  checkError = false,
  password = "2468",
  rejected = "0000",
) {
  await page.locator(".profile-button").click();
  await page
    .locator(".role-menu")
    .getByRole("button", { name: /家长端/ })
    .click();
  await unlockParent(checkError, /\/parent$/, password, rejected);
}
// Shell 的「孩子端」按钮先 navigate 再 POST /auth/child（src/App.tsx 的 goRole），
// 所以孩子端界面带着上一个会话的 cookie 就渲染出来了。切换后任何一次服务端读取都
// 必须等它真正落到服务端，否则会拿着刚被删掉的家长会话读到 401。
async function enterChild() {
  await page.locator(".profile-button").click();
  await page
    .locator(".role-menu")
    .getByRole("button", { name: /孩子端/ })
    .click();
  expectSwitch401 = true;
  await waitForState((s) => s.role === "child");
  expectSwitch401 = false;
}

await page.goto(`${baseUrl}/child/tasks`, { waitUntil: "networkidle" });
await settleRewards();
await openChildEnd();
await page.getByText("整理自己的书桌").waitFor();
let state = await getState();
assert.equal(state.children.length, 1);
const initialBalance = state.children.find(
  (c) => c.name === "米娅",
).pointsBalance;
const deskId = currentTask(state, "整理自己的书桌").id;
const task = page.locator(".task-card").filter({ hasText: "整理自己的书桌" });
// 一键提交就要在点击前挂好响应监听：没有第二次点击可等了。
const submitResponse = page.waitForResponse((response) =>
  response.url().includes(`/tasks/${deskId}/submit`),
);
// A real PNG rendered by the same engine that must decode it later: the old
// hand-written JPEG header was not decodable, so an <img> could never prove
// anything beyond the element existing.
const proofSize = 64;
const proofPng = Buffer.from(
  await page.evaluate((size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffb547";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#4da895";
    context.fillRect(size / 4, size / 4, size / 2, size / 2);
    return canvas.toDataURL("image/png").split(",")[1];
  }, proofSize),
  "base64",
);
await task.getByRole("button", { name: "完成任务" }).click();
const taskSubmit = await submitResponse;
assert.equal(taskSubmit.status(), 200);
state = await waitForState(
  (s) => s.tasks.find((t) => t.id === deskId)?.status === "pending_review",
);
assert.equal(
  state.children.find((c) => c.name === "米娅").pointsBalance,
  initialBalance,
);
// 提交不再收集备注与照片/视频：两端都只剩「提交时间」这一行，既没有缩略图，
// 也不再输出「未填写文字备注」/「未添加照片或视频」占位。
const childEvidence = task.locator(".submission-evidence");
await childEvidence.waitFor();
await childEvidence.locator(".evidence-heading time").waitFor();
assert.equal(
  await childEvidence.locator(".media-thumb, .media-video").count(),
  0,
);
assert.ok(!(await childEvidence.innerText()).includes("未填写"));
assert.ok(!(await childEvidence.innerText()).includes("未添加"));
await page.screenshot({
  path: ".artifacts/ui/evidence-child.png",
  fullPage: true,
});

await page.goto(`${baseUrl}/parent/tasks`, { waitUntil: "networkidle" });
await settleRewards();
await page.waitForURL(/\/child$/);
await unlockParent(true, /\/parent\/tasks$/);
await page.getByRole("link", { name: "任务管理" }).click();
const parentTask = page
  .locator(".admin-task-item")
  .filter({ hasText: "整理自己的书桌" });
// 孩子端提交不带货，所以家长端这一行只能看到提交时间：证据展示（缩略图、
// 查看器、内联播放器与 mp4 的 content-type）全部由下面的愿望「标记完成」证据覆盖。
const parentEvidence = parentTask.locator(".submission-evidence");
await parentEvidence.waitFor();
await parentEvidence.locator(".evidence-heading time").waitFor();
assert.equal(
  await parentEvidence.locator(".media-thumb, .media-video").count(),
  0,
);
await page.screenshot({
  path: ".artifacts/ui/evidence-parent.png",
  fullPage: true,
});
await parentTask.getByRole("button", { name: "确认", exact: true }).click();
await waitForState(
  (s) =>
    s.children.find((c) => c.name === "米娅")?.pointsBalance ===
    initialBalance + 20,
);
await parentTask.getByRole("button", { name: "编辑整理自己的书桌" }).click();
await page.getByLabel("任务名称").fill("整理书桌与书架");
await page.getByRole("button", { name: "保存修改" }).click();
await page.getByLabel("任务名称").waitFor({ state: "hidden" });

await page.getByRole("link", { name: "愿望管理" }).click();
const managedWish = page
  .locator(".admin-wish")
  .filter({ hasText: "公园探险半日游" });
await managedWish.getByRole("button", { name: "编辑公园探险半日游" }).click();
await page.getByLabel("愿望名称").fill("周末公园探险");
await page.getByRole("button", { name: "保存修改" }).click();
await waitForState((s) => s.wishes.some((w) => w.title === "周末公园探险"));
// 上/下架走的是 PUT /wishes/{id}，与 saveWish 共用 wishInput；客户端一旦把服务端
// DTO 整个展开回传（多出一个 id），DisallowUnknownFields 就会判成 400。
const renamedWish = page
  .locator(".admin-wish")
  .filter({ hasText: "周末公园探险" });
await renamedWish.getByRole("button", { name: "下架" }).click();
await waitForState(
  (s) => s.wishes.find((w) => w.title === "周末公园探险")?.isActive === false,
);
await renamedWish.getByRole("button", { name: "重新上架" }).click();
await waitForState(
  (s) => s.wishes.find((w) => w.title === "周末公园探险")?.isActive === true,
);
await page.getByRole("button", { name: "删除周末公园探险" }).click();
await page.getByRole("button", { name: "确认删除" }).click();
await waitForState((s) => !s.wishes.some((w) => w.title === "周末公园探险"));

await enterChild();
await page.getByText("+20 积分到账！").waitFor();
await page.getByRole("link", { name: "愿望", exact: true }).click();
state = await getState();
const dinner = state.wishes.find((w) => w.title === "选择一次晚餐");
const wish = page.locator(".wish-card").filter({ hasText: "选择一次晚餐" });
await wish.getByRole("button", { name: "去兑换" }).click();
await page.getByRole("button", { name: "确认兑换" }).click();
await waitForState(
  (s) =>
    s.children.find((c) => c.name === "米娅")?.pointsBalance ===
    initialBalance - 60,
);
await page.reload({ waitUntil: "networkidle" });
await settleRewards();
state = await getState();
assert.equal(
  state.children.find((c) => c.name === "米娅").pointsBalance,
  initialBalance - 60,
);
assert.equal(state.redemptions.at(-1).wishId, dinner.id);
const starRow = page.locator(".star-row").filter({ hasText: "选择一次晚餐" });
const wishNote = "晚餐点了披萨，全家一起吃光啦";
await starRow.getByRole("button", { name: "标记完成" }).click();
await starRow.getByPlaceholder("写一句话记录这一刻吧（可选，30 字以内）").fill(wishNote);
await starRow.locator('input[accept="image/*"]').setInputFiles({
  name: "wish-proof.png",
  mimeType: "image/png",
  buffer: proofPng,
});
await starRow.locator('input[accept="video/*"]').setInputFiles({
  name: "wish-proof.mp4",
  mimeType: "video/mp4",
  buffer: Buffer.from(
    "00000018667479706d703432000000006d70343269736f6d",
    "hex",
  ),
});
await starRow.getByRole("button", { name: "确认完成" }).click();
state = await waitForState((s) => Boolean(s.redemptions.at(-1)?.completedAt));
assert.equal(state.redemptions.at(-1).completedNote, wishNote);
assert.equal(state.redemptions.at(-1).attachments.length, 2);
await page.reload({ waitUntil: "networkidle" });
await settleRewards();
await starRow.getByText("已完成").waitFor();
await starRow.getByText(wishNote).waitFor();
await assertRealImage(starRow.locator(".media-thumb img"), proofSize);
assert.equal(
  await starRow.locator(".media-thumb, .media-video").count(),
  2,
);
assert.equal(await starRow.getByRole("button", { name: "标记完成" }).count(), 0);
assert.equal(await starRow.getByRole("button", { name: "撤销完成" }).count(), 1);

await enterParent();
await page.getByRole("link", { name: "愿望管理" }).click();
const parentStarRow = page
  .locator(".star-row")
  .filter({ hasText: "选择一次晚餐" });
assert.ok((await parentStarRow.innerText()).includes("米娅"));
await parentStarRow.getByText("已完成").waitFor();
await parentStarRow.getByText(wishNote).waitFor();
await assertRealImage(parentStarRow.locator(".media-thumb img"), proofSize);
await parentStarRow.getByAltText("wish-proof.png").waitFor();
await parentStarRow.locator(".media-thumb").click();
await page.locator(".media-viewer img").waitFor();
await page.locator(".modal-backdrop .modal-close").click();
await page.locator(".media-viewer").waitFor({ state: "detached" });
const video = parentStarRow.locator(".media-video");
assert.ok(await video.evaluate((node) => node.controls));
assert.deepEqual(
  await page.evaluate(async () => {
    const response = await fetch(document.querySelector(".media-video").src);
    return [response.status, response.headers.get("content-type")];
  }),
  [200, "video/mp4"],
);
assert.equal(await parentStarRow.getByRole("button", { name: "标记完成" }).count(), 0);
assert.equal(await parentStarRow.getByRole("button", { name: "撤销完成" }).count(), 0);
await page.getByRole("link", { name: "任务管理" }).click();
const readingTask = page
  .locator(".admin-row")
  .filter({ hasText: "阅读 20 分钟" });
// 退回必须带原因：孩子端只能从 submission.reviewNote 看到「为什么要重做」。
const rejectNote = "先把书签放好再拍照";
await readingTask.getByRole("button", { name: "退回" }).click();
await readingTask.getByLabel("退回原因").fill(rejectNote);
await readingTask.getByRole("button", { name: "确认退回" }).click();
await waitForState(
  (s) => currentTask(s, "阅读 20 分钟")?.status === "rejected",
);
await enterChild();
await page.getByRole("link", { name: "愿望", exact: true }).click();
const reopenRow = page.locator(".star-row").filter({ hasText: "选择一次晚餐" });
await reopenRow.getByRole("button", { name: "撤销完成" }).click();
await page.getByRole("button", { name: "确认撤销" }).click();
await waitForState((s) => !s.redemptions.at(-1)?.completedAt);
await reopenRow.getByText("未完成").waitFor();
assert.equal(
  await reopenRow.locator(".media-thumb, .media-video").count(),
  0,
);
assert.ok(!(await reopenRow.innerText()).includes(wishNote));
await page.getByRole("link", { name: "任务", exact: true }).click();
const rejectedTask = page
  .locator(".task-card")
  .filter({ hasText: "阅读 20 分钟" });
assert.ok(
  (await rejectedTask.innerText()).includes(`家长：${rejectNote}`),
  "退回原因没有显示在孩子的 rejected 卡片上",
);
await rejectedTask.getByRole("button", { name: "重新提交" }).click();
await waitForState(
  (s) =>
    s.submissions.filter(
      (item) =>
        item.taskId === currentTask(s, "阅读 20 分钟")?.id,
    ).length === 2,
);

await enterParent();
await page.getByRole("link", { name: "孩子管理" }).click();
await page.getByRole("button", { name: "新增孩子" }).click();
await page.getByLabel("孩子姓名").fill("小安");
await page.getByRole("button", { name: "添加孩子" }).click();
await waitForState((s) => s.children.some((c) => c.name === "小安"));
await page.getByRole("button", { name: "编辑小安" }).click();
await page.getByLabel("孩子姓名").fill("安安");
await page.getByRole("button", { name: "保存修改" }).click();
await waitForState((s) => s.children.some((c) => c.name === "安安"));
// 演示数据只有一个孩子，切换孩子的覆盖靠家长刚建的这个孩子：孩子端在两个
// 档案之间各切一次（每次都是 PATCH /session/child，两次目标不同，至少一次
// 必然是真切换）。
await enterChild();
await page.locator(".bottom-nav").waitFor();
await switchChild("米娅");
await switchChild("安安");
await enterParent();
await page.getByRole("link", { name: "孩子管理" }).click();
await page.getByRole("button", { name: "删除安安" }).click();
await page.getByRole("button", { name: "确认删除" }).click();
await waitForState((s) => !s.children.some((c) => c.name === "安安"));
// Growth calendar: 米娅's day holds four real instances (three completed, one
// pending review) and today's only earned ledger entry is this run's +20
// approval, so the screen must derive all of it from /state instead of the
// hard-coded chart it used to render. A 补录 needs a submission whose
// family-local date differs from the instance's due_date, and the server
// stamps both, so a shifted browser clock cannot fabricate one: only a task
// scheduled for another weekday can. Weekday +3 can never be today's ISO
// weekday, so the due date always lands on a real 补录.
const familyToday = await page.evaluate(async () => {
  const state = await (await fetch("/api/v1/state")).json();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: state.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    weekday: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
      value("weekday")
    ],
  };
});
await page.getByRole("link", { name: "任务管理" }).click();
await page.getByRole("button", { name: "新建任务" }).click();
await page.getByLabel("任务名称").fill("每周整理书架");
await page.getByLabel("重复方式").selectOption("weekly");
// 勾选式星期：默认勾着今天，这条要排在别的日子才验得出补录，所以先取消今天、
// 再勾上目标那天（顺便验一遍这个开关两个方向都能动）。
const otherWeekday = (familyToday.weekday + 3) % 7;
const weekdayChip = (index) =>
  page.getByRole("button", { name: `每周${"日一二三四五六"[index]}` });
await weekdayChip(familyToday.weekday).click();
await weekdayChip(otherWeekday).click();
assert.deepEqual(
  await page.locator('.weekday-chip[aria-pressed="true"]').allInnerTexts(),
  ["日一二三四五六"[otherWeekday]],
  `只该勾上${"日一二三四五六"[otherWeekday]}`,
);
await page.getByRole("button", { name: "发布任务" }).click();
state = await waitForState((s) => Boolean(currentTask(s, "每周整理书架")));
const weeklyTask = currentTask(state, "每周整理书架");
assert.equal(
  weeklyTask.childId,
  state.children.find((c) => c.name === "米娅").id,
);
assert.notEqual(weeklyTask.dueDate, familyToday.date);

await enterChild();
await switchChild("米娅");
await page.getByRole("link", { name: "成长", exact: true }).click();
const dayPanel = page.locator(".day-panel");
// The parent renamed the template to 整理书桌与书架, but the instance keeps its
// own title: saveTask only syncs instances that are todo/rejected and never
// submitted.
await dayPanel
  .locator(".day-task")
  .filter({ hasText: "整理自己的书桌" })
  .waitFor();
assert.equal(await page.locator(".calendar-day.selected").count(), 1);
let dayText = await dayPanel.innerText();
assert.ok(dayText.includes("已完成 3"));
assert.ok(dayText.includes("待确认 1"));
assert.ok(dayText.includes("获得 20 积分"));
assert.ok(!dayText.includes("补录"));
// 日历每格都带农历小字，周末/官方假期打「休」角标，日期面板的标题也带农历。
assert.equal(
  await page.locator(".calendar-day .calendar-lunar").count(),
  await page.locator(".calendar-day").count(),
);
assert.ok((await page.locator(".calendar-mark.rest").count()) >= 8);
assert.ok((await dayPanel.locator(".date-lunar").innerText()).includes("农历"));
// 连续打卡徽章：点亮与未点亮加起来必须是全套，成就卡文案跟着 streakDays 走。
const streakNow = state.children.find((c) => c.name === "米娅").streakDays;
assert.equal(await page.locator(".badge-chip").count(), 6);
assert.equal(
  (await page.locator(".badge-chip:not(.locked)").count()) +
    (await page.locator(".badge-chip.locked").count()),
  6,
);
assert.equal(
  await page.locator(".badge-chip:not(.locked)").count(),
  [3, 7, 14, 30, 60, 100].filter((days) => streakNow >= days).length,
);
const achievementText = await page.locator(".achievement p").innerText();
if (streakNow < 100) {
  const nextDays = [3, 7, 14, 30, 60, 100].find((days) => streakNow < days);
  assert.ok(
    achievementText.includes(`再坚持 ${nextDays - streakNow} 天`),
    `成就文案没跟着 streakDays=${streakNow} 走：${achievementText}`,
  );
}
await page.screenshot({
  path: ".artifacts/ui/growth-day.png",
  fullPage: true,
});

await page.getByRole("link", { name: "任务", exact: true }).click();
const weeklyCard = page
  .locator(".task-card")
  .filter({ hasText: "每周整理书架" });
await weeklyCard.getByRole("button", { name: "完成任务" }).click();
await waitForState(
  (s) =>
    currentTask(s, "每周整理书架")?.status === "pending_review",
);
await page.getByRole("link", { name: "成长", exact: true }).click();
const backfilled = dayPanel
  .locator(".day-task")
  .filter({ hasText: "每周整理书架" });
await backfilled.waitFor();
assert.ok((await backfilled.innerText()).includes("原定 "));
dayText = await dayPanel.innerText();
assert.ok(dayText.includes("补录记录"));
assert.ok(dayText.includes("补录 1"));
assert.ok(dayText.includes("待确认 1"));
assert.equal(
  await page.locator(".calendar-day.selected .calendar-dot.backfill").count(),
  1,
);
await page.screenshot({
  path: ".artifacts/ui/growth-backfill.png",
  fullPage: true,
});
// 每个被确认的任务各弹一次到账：家长先连续确认两条任务，孩子端第一次打开时
// 必须把两笔到账逐条走完，而不是只庆祝最新的一条。
await enterParent();
await page.getByRole("link", { name: "任务管理" }).click();
const readingRow = page
  .locator(".admin-task-item")
  .filter({ hasText: "阅读 20 分钟" })
  .first();
await readingRow.getByRole("button", { name: "确认", exact: true }).click();
let approved = await waitForState(
  (s) => currentTask(s, "阅读 20 分钟")?.status === "completed",
);
const readingPoints = currentTask(approved, "阅读 20 分钟").points;
// created_at 是去掉尾零的 RFC3339Nano，同一秒内的两条记录不能保证字典序等于
// 时间序；这里让两次确认跨秒，排队顺序才是确定的。
await page.waitForTimeout(1100);
const weeklyRow = page
  .locator(".admin-task-item")
  .filter({ hasText: "每周整理书架" })
  .first();
await weeklyRow.getByRole("button", { name: "确认", exact: true }).click();
approved = await waitForState(
  (s) => currentTask(s, "每周整理书架")?.status === "completed",
);
const weeklyPoints = currentTask(approved, "每周整理书架").points;

// 家长端深链（地址栏直接敲 /parent）只是「门口要密码」：地址先被换到 /child，
// 密码框挡在前面，这一屏是家长在开门，不是孩子在看在账——既不该弹，更不该把游标
// 推过去把孩子这两笔吃掉。
const cursorBeforeGate = cursorOf(await getState());
await page.goto(`${baseUrl}/parent`, { waitUntil: "networkidle" });
await page.locator(".pin-modal").waitFor();
assert.match(page.url(), /\/child$/);
await page.waitForTimeout(4200);
assert.equal(await page.locator(".reward-celebration").count(), 0);
assert.equal(cursorOf(await getState()), cursorBeforeGate);
await unlockParent();
assert.equal(cursorOf(await getState()), cursorBeforeGate);

const cursorBeforePreview = cursorOf(await getState());
await enterChild();
const celebration = page.locator(".reward-celebration");
await celebration.getByText("完成「阅读 20 分钟」").waitFor();
assert.equal(
  await celebration.locator("strong").innerText(),
  `+${readingPoints} 积分到账！`,
);
assert.equal(await page.locator(".reward-celebration").count(), 1);
assert.ok(!(await celebration.innerText()).includes("每周整理书架"));
await page.screenshot({
  path: ".artifacts/ui/reward-queue.png",
  fullPage: true,
});
await celebration.getByRole("button", { name: "关闭积分到账提示" }).click();
await page.getByText("完成「每周整理书架」").waitFor();
assert.equal(
  await page.locator(".reward-celebration strong").innerText(),
  `+${weeklyPoints} 积分到账！`,
);
await page
  .locator(".reward-celebration")
  .getByRole("button", { name: "关闭积分到账提示" })
  .click();
await page.locator(".reward-celebration").waitFor({ state: "detached" });
// 预览不算看过：家长从菜单切过来这一趟弹完的两笔，游标必须原地不动，孩子自己打开
// （刷新就是正常打开）时还得再弹一遍。游标落在服务端，换设备、重装也一样。
assert.equal(cursorOf(await getState()), cursorBeforePreview);
const earnedCursor = (await getState()).ledger
  .filter((item) => item.type === "earned")
  .map((item) => item.createdAt)
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  .at(-1);
assert.ok(
  cursorBeforePreview < earnedCursor,
  `cursor ${cursorBeforePreview} already covers ${earnedCursor}`,
);
await page.reload({ waitUntil: "networkidle" });
const replayed = page.locator(".reward-celebration");
await replayed.getByText("完成「阅读 20 分钟」").waitFor();
assert.equal(await replayed.locator("strong").innerText(), `+${readingPoints} 积分到账！`);
assert.equal(await replayed.count(), 1);
assert.ok(!(await replayed.innerText()).includes("每周整理书架"));
await replayed.getByRole("button", { name: "关闭积分到账提示" }).click();
await page.getByText("完成「每周整理书架」").waitFor();
assert.equal(
  await page.locator(".reward-celebration strong").innerText(),
  `+${weeklyPoints} 积分到账！`,
);
await page
  .locator(".reward-celebration")
  .getByRole("button", { name: "关闭积分到账提示" })
  .click();
await page.locator(".reward-celebration").waitFor({ state: "detached" });
// 队列走完才推进游标，之后刷新不再重弹。
assert.equal(cursorOf(await waitForState((s) => cursorOf(s) === earnedCursor)), earnedCursor);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
assert.equal(await page.locator(".reward-celebration").count(), 0);
// 成长统计：区间由服务端 from/to 决定，卡片和柱状图随区间变化，不再是写死的 7 天。
await enterParent();
await page.getByRole("link", { name: "成长统计" }).click();
await page.waitForURL(/\/parent\/stats$/);
const statValue = async (index) =>
  Number(await page.locator(".stats-cards strong").nth(index).innerText());
const barCount = () => page.locator(".bar-chart .bar-col").count();
// 换区间会触发一次 /api/v1/stats?from=… 请求，React 只在它回来后才重渲染；下面每次
// 都先挂 waitForResponse 再改控件，并在断言前轮询到期望值，才不会读到上一轮的数字。
const poll = async (read, expected) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await read()) === expected) return;
    await page.waitForTimeout(50);
  }
  assert.equal(await read(), expected);
};
const waitForBars = (expected) => poll(barCount, expected);
const waitForStat = (index, expected) =>
  poll(() => statValue(index), expected);
const ranged = async (act) => {
  const pending = page.waitForResponse((response) =>
    response.url().includes("/api/v1/stats?from="),
  );
  await act();
  await pending;
};
await page.locator(".range-picker select").waitFor();
await waitForBars(7);
assert.ok((await statValue(1)) >= 20 + readingPoints + weeklyPoints);
const completedWeek = await statValue(0);
await ranged(() => page.getByLabel("统计范围").selectOption("today"));
await waitForBars(1);
await waitForStat(1, 20 + readingPoints + weeklyPoints);
await ranged(() => page.getByLabel("统计范围").selectOption("month"));
await waitForBars(30);
// 种子里有一天落在 7 天之外，所以 30 天区间必须比最近 7 天多出确认记录。
assert.ok((await statValue(0)) > completedWeek);
await ranged(() => page.getByLabel("统计范围").selectOption("custom"));
const yesterday = new Date(
  new Date(`${familyToday.date}T00:00:00Z`).getTime() - 86400000,
)
  .toISOString()
  .slice(0, 10);
await page.getByLabel("开始日期").fill(yesterday);
await page.getByLabel("结束日期").fill(yesterday);
await ranged(() => page.getByRole("button", { name: "应用" }).click());
// 种子里「一天前」那笔确认：阅读 20 分钟。
await waitForStat(1, 30);
await waitForBars(1);
await page.screenshot({
  path: ".artifacts/ui/stats-range.png",
  fullPage: true,
});
// 下面还要点一次「家长端」才弹 PIN，所以必须先回到孩子端。
await enterChild();
// 家长端可以修改家长密码：先要当前密码，改完旧密码立即失效、新密码才能进入。
await enterParent();
await page.locator(".profile-button").click();
await page
  .locator(".role-menu")
  .getByRole("button", { name: /修改家长密码/ })
  .click();
const passwordModal = page.locator(".form-modal");
await passwordModal.getByLabel("当前密码").fill("2468");
await passwordModal.getByLabel("新密码", { exact: true }).fill("1357");
await passwordModal.getByLabel("确认新密码").fill("1358");
await passwordModal.getByRole("button", { name: "保存新密码" }).click();
// 两遍新密码不一致：前端拦截，不发请求，弹窗不关。
await passwordModal.getByText("两次输入的新密码不一致").waitFor();
await passwordModal.getByLabel("确认新密码").fill("1357");
await passwordModal.getByLabel("当前密码").fill("0000");
expectAuth401 = true;
await passwordModal.getByRole("button", { name: "保存新密码" }).click();
await passwordModal.getByText("当前密码不正确，请重新输入").waitFor();
expectAuth401 = false;
assert.equal(await passwordModal.getByLabel("当前密码").inputValue(), "");
// 401 不能被 src/store.ts 的「重开孩子端并重放」吃掉：家长端必须还在。
await page.locator(".parent-layout").waitFor();
await passwordModal.getByLabel("当前密码").fill("2468");
await passwordModal.getByRole("button", { name: "保存新密码" }).click();
await page.getByText("家长密码已更新").waitFor();
await page.locator(".form-modal").waitFor({ state: "detached" });

await enterChild();
await page.locator(".bottom-nav").waitFor();
await enterParent(true, "1357", "2468");
// 到这里米娅今天已经没有可提交的任务了，而退化页必须真的提交一次才能证明
// idempotencyKey 的 UUID 兜底：家长补一条今天的任务给它。
await page.getByRole("link", { name: "任务管理" }).click();
await page.getByRole("button", { name: "新建任务" }).click();
// 推荐任务只是把下面的字段填好（它不新建任何东西）：点一下，名称与重复方式就跟着变。
await page.getByRole("button", { name: /^倒垃圾\s*10$/ }).click();
assert.equal(await page.getByLabel("任务名称").inputValue(), "倒垃圾");
assert.equal(await page.getByLabel("重复方式").inputValue(), "daily");
await page.getByLabel("任务名称").fill("倒垃圾");
await page.getByLabel("重复方式").selectOption("daily");
await page.getByRole("button", { name: "发布任务" }).click();
state = await waitForState((s) => Boolean(currentTask(s, "倒垃圾")));
assert.equal(
  currentTask(state, "倒垃圾").childId,
  state.children.find((c) => c.name === "米娅").id,
);
// Both harnesses run on 127.0.0.1, a secure context where crypto.randomUUID
// always exists, so nothing above reaches the idempotency-key fallback in
// src/store.ts that plain-HTTP LAN deployments depend on: there the browser
// reports isSecureContext false and randomUUID is undefined, which used to
// abort every submit/review/redeem with a TypeError before fetch was called.
// Deleting the method restores that shape deterministically, and the key must
// still reach the server, so this cannot silently regress again.
const degraded = await browser.newPage({
  viewport: { width: 390, height: 844 },
});
collectErrors(degraded);
await degraded.addInitScript(() => {
  delete Crypto.prototype.randomUUID;
});
await degraded.goto(baseUrl);
await degraded.locator(".bottom-nav").waitFor();
assert.equal(
  await degraded.evaluate(() => typeof crypto.randomUUID),
  "undefined",
);
const degradedCard = degraded
  .locator(".task-card")
  .filter({ hasText: "倒垃圾" });
await degradedCard.waitFor();
const degradedSubmit = degraded.waitForResponse((response) =>
  response.url().includes("/submit"),
);
await degradedCard.getByRole("button", { name: "完成任务" }).click();
const submitted = await degradedSubmit;
assert.equal(submitted.status(), 200);
assert.match(
  submitted.request().headers()["idempotency-key"],
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
await degraded.close();

// 家长可以直接给当前孩子加分/扣分（家庭总览页右上角「奖励积分」）：加分与任务
// 审核共用一套账（积分 + 成长能量），扣分只减积分；两者都是 manual 台账，孩子端
// 下次打开会像任务到账一样弹一次提示。
await page.getByRole("link", { name: "家庭总览" }).click();
const beforeAward = await waitForState((s) => s.children.length > 0);
const target = beforeAward.children.find(
  (c) => c.id === beforeAward.activeChildId,
);
assert.equal(target.name, "米娅");
await page.getByRole("button", { name: "奖励积分" }).click();
const pointsModal = page.locator(".form-modal");
await pointsModal.getByLabel("积分数量").fill("30");
await pointsModal.getByLabel("原因（可选）").fill("主动整理客厅");
await page.screenshot({
  path: ".artifacts/ui/points-award.png",
  fullPage: true,
});
await pointsModal.getByRole("button", { name: "确认奖励" }).click();
await page.locator(".form-modal").waitFor({ state: "detached" });
const awarded = await waitForState(
  (s) =>
    s.children.find((c) => c.id === target.id).pointsBalance ===
    target.pointsBalance + 30,
);
const awardedChild = awarded.children.find((c) => c.id === target.id);
assert.equal(awardedChild.experience, (target.experience + 6) % 100);
const awardEntry = awarded.ledger.find(
  (item) => item.description === "家长奖励：主动整理客厅",
);
assert.equal(awardEntry.amount, 30);
assert.equal(awardEntry.referenceType, "manual");
// 扣分只减积分，成长能量不动。
await page.getByRole("button", { name: "奖励积分" }).click();
const deductModal = page.locator(".form-modal");
await deductModal.getByRole("button", { name: "扣除积分" }).click();
await deductModal.getByLabel("积分数量").fill("20");
await deductModal.getByRole("button", { name: "确认扣除" }).click();
await page.locator(".form-modal").waitFor({ state: "detached" });
const deducted = await waitForState(
  (s) =>
    s.children.find((c) => c.id === target.id).pointsBalance ===
    target.pointsBalance + 10,
);
assert.equal(
  deducted.children.find((c) => c.id === target.id).experience,
  awardedChild.experience,
);
assert.equal(
  deducted.ledger.find((item) => item.description === "家长扣除").amount,
  -20,
);
// 孩子端为一笔手动加分弹到账提示，且标题不再是「任务确认完成」。
await enterChild();
const manualReward = page.locator(".reward-celebration");
await manualReward.getByText("家长奖励：主动整理客厅").waitFor();
assert.ok((await manualReward.innerText()).includes("家长奖励"));
assert.equal(
  await manualReward.locator("strong").innerText(),
  "+30 积分到账！",
);
await manualReward.getByRole("button", { name: "关闭积分到账提示" }).click();
await page.locator(".reward-celebration").waitFor({ state: "detached" });

// ── 积分激励闭环：家长添加一个买不起的愿望 → 孩子端看见进度条与「还差 N」→
// 积分账本逐笔结余对得上 → 家长一笔加分跨过一次升级线 → 孩子端弹升级提示 →
// 兑换一次，账本顶行记下这笔支出与新的结余。全部期望值都从 /state 现读现算。
await enterParent(false, "1357");
await page.getByRole("link", { name: "愿望管理" }).click();
await page.getByRole("button", { name: "添加愿望" }).click();
const wishForm = page.locator(".form-modal");
await wishForm.getByLabel("愿望名称").fill("周末露营野餐");
await wishForm.getByLabel("需要积分").fill("5000");
await wishForm.getByRole("button", { name: "放入愿望小铺" }).click();
await page.locator(".form-modal").waitFor({ state: "detached" });
await waitForState((s) => s.wishes.some((w) => w.title === "周末露营野餐"));
await enterChild();
await page.getByRole("link", { name: "愿望", exact: true }).click();
state = await getState();
const miaBefore = state.children.find((c) => c.id === state.activeChildId);
const activeWishes = state.wishes.filter((w) => w.isActive);
// 每张上架的愿望卡都带进度条：条数必须和卡数一致，缺一半都不算过。
assert.equal(
  await page.locator(".wish-progress").count(),
  await page.locator(".wish-card").count(),
);
assert.equal(
  await page.locator(".wish-card").count(),
  activeWishes.length,
  "愿望卡数量和上架愿望对不上",
);
// 5000 分永远买不起：按钮是禁用的「还差 N」，进度条按余额/标价画。
const far = page.locator(".wish-card").filter({ hasText: "周末露营野餐" });
const saved = Math.max(0, Math.min(miaBefore.pointsBalance, 5000));
const percent = Math.round((miaBefore.pointsBalance / 5000) * 100);
assert.equal(
  await far.locator("button.small-disabled").innerText(),
  `还差 ${5000 - miaBefore.pointsBalance}`,
);
assert.equal(
  await far.locator(".wish-progress").getAttribute("aria-label"),
  `已攒 ${saved}/5000 积分`,
);
assert.equal(
  await far.locator(".wish-progress > span").evaluate((node) => node.style.width),
  `${Math.max(0, Math.min(100, percent))}%`,
);
await page.screenshot({ path: ".artifacts/ui/wish-progress.png", fullPage: true });
// 积分账本：总数、笔数、逐笔结余都要和 /state 对得上；最新那行的结余就是余额。
await page.getByRole("link", { name: "今日", exact: true }).click();
await page.locator(".balance-link").click();
await page.waitForURL(/\/child\/ledger$/);
assert.equal(
  await page.locator(".ledger-total strong").innerText(),
  String(miaBefore.pointsBalance),
);
const miaLedger = state.ledger.filter((item) => item.childId === miaBefore.id);
assert.equal(
  await page.locator(".ledger-total small").innerText(),
  `共 ${miaLedger.length} 笔记录`,
);
assert.equal(
  await page.locator(".activity-list > div").count(),
  miaLedger.length,
  "账本行数和这个孩子的台账条数对不上",
);
const newestEntry = miaLedger.at(-1);
const topRow = page.locator(".activity-list > div").first();
await topRow.locator("strong").waitFor();
assert.ok(
  (await topRow.innerText()).includes(newestEntry.description),
  `账本顶行不是最新一笔（${newestEntry.description}）`,
);
assert.equal(
  await topRow.locator(".ledger-after").innerText(),
  `结余 ${miaBefore.pointsBalance}`,
);
await page.screenshot({ path: ".artifacts/ui/ledger-page.png", fullPage: true });
// 一笔加分跨过升级线：奖励 (100-当前能量)*5 分，成长能量恰好 +（100-能量），
// 等级 +1、能量归零（服务端 growth = amount/5，等级由总能量算）。
await enterParent(false, "1357");
await page.getByRole("link", { name: "家庭总览" }).click();
const beforeLevel = await waitForState((s) => s.children.length > 0);
const levelChild = beforeLevel.children.find(
  (c) => c.id === beforeLevel.activeChildId,
);
const growthNeeded = 100 - levelChild.experience;
const levelAward = growthNeeded * 5;
await page.getByRole("button", { name: "奖励积分" }).click();
const levelModal = page.locator(".form-modal");
await levelModal.getByLabel("积分数量").fill(String(levelAward));
await levelModal.getByLabel("原因（可选）").fill("升级奖励");
await levelModal.getByRole("button", { name: "确认奖励" }).click();
await page.locator(".form-modal").waitFor({ state: "detached" });
const leveled = await waitForState(
  (s) =>
    s.children.find((c) => c.id === levelChild.id).level ===
    levelChild.level + 1,
);
assert.equal(
  leveled.children.find((c) => c.id === levelChild.id).experience,
  0,
  "跨过升级线后成长能量该归零",
);
// 孩子端同时收到到账横幅与升级提示：横幅要点掉，toast 自己走。
await enterChild();
const levelReward = page.locator(".reward-celebration");
await levelReward.getByText("家长奖励", { exact: true }).waitFor();
assert.equal(
  await levelReward.locator("strong").innerText(),
  `+${levelAward} 积分到账！`,
);
assert.equal(
  await page.locator(".level-up strong").innerText(),
  `升到 Lv.${levelChild.level + 1}`,
);
await levelReward.getByRole("button", { name: "关闭积分到账提示" }).click();
await page.locator(".reward-celebration").waitFor({ state: "detached" });
await page.locator(".level-up").waitFor({ state: "detached", timeout: 5000 });
// 兑换最便宜的那个愿望，账本顶行立刻记下这笔支出与结余。
await page.getByRole("link", { name: "愿望", exact: true }).click();
const redeemState = await waitForState((s) => {
  const child = s.children.find((c) => c.id === s.activeChildId);
  return (
    child.pointsBalance >=
    Math.min(
      ...s.wishes
        .filter((w) => w.isActive && !s.redemptions.some((r) => r.wishId === w.id))
        .map((w) => w.pointsCost),
    )
  );
});
const redeemChild = redeemState.children.find(
  (c) => c.id === redeemState.activeChildId,
);
const targetWish = redeemState.wishes
  .filter(
    (w) =>
      w.isActive &&
      !redeemState.redemptions.some((r) => r.wishId === w.id) &&
      w.pointsCost <= redeemChild.pointsBalance,
  )
  .sort((a, b) => a.pointsCost - b.pointsCost)[0];
const redeemCard = page
  .locator(".wish-card")
  .filter({ hasText: targetWish.title });
await redeemCard.getByRole("button", { name: "去兑换" }).click();
await page.getByRole("button", { name: "确认兑换" }).click();
const redeemed = await waitForState(
  (s) =>
    s.children.find((c) => c.id === s.activeChildId).pointsBalance ===
    redeemChild.pointsBalance - targetWish.pointsCost,
);
await page.getByRole("link", { name: "今日", exact: true }).click();
await page.locator(".balance-link").click();
await page.waitForURL(/\/child\/ledger$/);
const spendRow = page
  .locator(".activity-list > div")
  .filter({ hasText: `兑换「${targetWish.title}」` })
  .first();
await spendRow.waitFor();
assert.equal(
  await spendRow.locator(".negative").innerText(),
  `-${targetWish.pointsCost}`,
);
assert.equal(
  await spendRow.locator(".ledger-after").innerText(),
  `结余 ${redeemed.children.find((c) => c.id === redeemed.activeChildId).pointsBalance}`,
);

// ── 华容道：五关按序解锁，第 1 关必须用真实 UI 一格一格滑到出口（下面 118 步是
// BFS 从同一布局算出的最短解，UI 里「点棋子 + 点亮起的空位」恰好一格一步），
// 首通才 +30；低于最短解的上报、跳关、不存在的关卡都被服务端当场拦下。
const klotskiLevel1 = [
  ["q", 3, 1], ["p", 4, 1], ["D", 3, 0], ["G", 2, 0], ["E", 2, 2], ["s", 3, 3],
  ["r", 4, 3], ["E", 3, 2], ["G", 2, 1], ["G", 2, 2], ["q", 2, 1], ["p", 3, 1],
  ["q", 2, 0], ["p", 2, 1], ["E", 3, 1], ["r", 4, 2], ["s", 4, 3], ["G", 3, 2],
  ["p", 2, 2], ["p", 2, 3], ["q", 2, 1], ["D", 2, 0], ["q", 2, 2], ["E", 2, 1],
  ["r", 4, 1], ["r", 4, 0], ["s", 4, 2], ["s", 4, 1], ["G", 4, 2], ["p", 3, 3],
  ["q", 2, 3], ["E", 2, 2], ["D", 2, 1], ["A", 1, 0], ["A", 2, 0], ["C", 0, 0],
  ["B", 0, 2], ["q", 1, 3], ["p", 2, 3], ["q", 0, 3], ["p", 1, 3], ["E", 2, 3],
  ["B", 1, 2], ["B", 2, 2], ["C", 0, 1], ["A", 1, 0], ["A", 0, 0], ["D", 2, 0],
  ["s", 3, 1], ["r", 4, 1], ["s", 2, 1], ["r", 3, 1], ["G", 4, 1], ["E", 3, 3],
  ["G", 4, 0], ["B", 3, 2], ["s", 2, 2], ["s", 2, 3], ["C", 1, 1], ["q", 0, 2],
  ["p", 0, 3], ["q", 0, 1], ["p", 0, 2], ["s", 1, 3], ["E", 2, 3], ["s", 0, 3],
  ["E", 1, 3], ["B", 3, 3], ["r", 3, 2], ["r", 4, 2], ["C", 2, 1], ["p", 1, 2],
  ["q", 0, 2], ["A", 0, 1], ["D", 1, 0], ["D", 0, 0], ["C", 2, 0], ["p", 2, 2],
  ["p", 3, 2], ["q", 1, 2], ["s", 0, 2], ["E", 0, 3], ["B", 2, 3], ["r", 4, 3],
  ["p", 4, 2], ["C", 2, 1], ["D", 1, 0], ["D", 2, 0], ["A", 0, 0], ["q", 1, 1],
  ["s", 0, 1], ["E", 0, 2], ["B", 1, 3], ["B", 0, 3], ["C", 2, 2], ["D", 2, 1],
  ["A", 1, 0], ["s", 0, 0], ["q", 0, 1], ["D", 1, 1], ["G", 3, 0], ["p", 4, 1],
  ["p", 4, 0], ["r", 4, 2], ["r", 4, 1], ["C", 3, 2], ["B", 1, 3], ["E", 1, 2],
  ["q", 0, 2], ["q", 0, 3], ["s", 0, 1], ["A", 0, 0], ["s", 0, 2], ["D", 0, 1],
  ["G", 2, 0], ["p", 3, 0], ["r", 4, 0], ["C", 3, 1],
];
const klotskiLevel2 = [
  ["E", 3, 2], ["r", 2, 2], ["B", 1, 3], ["s", 4, 3], ["B", 2, 3], ["C", 0, 2],
  ["A", 0, 1], ["p", 1, 0], ["p", 0, 0], ["q", 2, 0], ["q", 1, 0], ["D", 2, 0],
  ["A", 1, 1], ["A", 2, 1], ["C", 0, 1], ["B", 1, 3], ["B", 0, 3], ["s", 3, 3],
  ["s", 2, 3], ["E", 3, 3], ["G", 4, 1], ["D", 3, 0], ["r", 3, 2], ["s", 2, 2],
  ["E", 2, 3], ["G", 4, 2], ["A", 3, 1], ["s", 2, 1], ["s", 2, 0], ["C", 1, 1],
  ["p", 0, 1], ["p", 0, 2], ["q", 0, 0], ["q", 0, 1], ["s", 1, 0], ["D", 2, 0],
  ["s", 0, 0], ["D", 1, 0], ["A", 3, 0], ["r", 3, 1], ["r", 4, 1], ["C", 2, 1],
  ["p", 1, 2], ["p", 1, 1], ["B", 0, 2], ["E", 1, 3], ["E", 0, 3], ["C", 2, 2],
  ["p", 2, 1], ["p", 3, 1], ["q", 1, 1], ["s", 0, 1], ["D", 0, 0], ["A", 2, 0],
  ["r", 4, 0], ["p", 4, 1], ["C", 2, 1], ["E", 1, 3], ["E", 2, 3], ["B", 0, 3],
  ["q", 1, 2], ["s", 0, 2], ["D", 0, 1], ["A", 1, 0], ["A", 0, 0], ["C", 2, 0],
  ["E", 2, 2], ["B", 1, 3], ["s", 0, 3], ["q", 0, 2], ["E", 1, 2], ["G", 3, 2],
  ["p", 4, 2], ["p", 4, 3], ["r", 4, 1], ["r", 4, 2], ["C", 3, 0], ["A", 1, 0],
  ["D", 1, 1], ["q", 0, 1], ["q", 0, 0], ["s", 0, 2], ["B", 0, 3], ["s", 0, 1],
  ["E", 0, 2], ["G", 2, 2], ["p", 3, 3], ["r", 4, 3], ["C", 3, 1],
];
const gameBalance = redeemed.children.find((c) => c.id === redeemed.activeChildId).pointsBalance;
await page.getByRole("link", { name: "今日", exact: true }).click();
const gameTeaser = page.locator(".game-teaser");
await gameTeaser.waitFor();
assert.ok((await gameTeaser.innerText()).includes("已通关 0/5"), "开局首页应显示已通关 0/5");
await gameTeaser.click();
await page.waitForURL(/\/child\/games$/);
await page.locator(".game-card").first().waitFor();
assert.equal(await page.locator(".game-card").count(), 7, "5 关华容道 + 口算 + 找规律共 7 张卡");
assert.equal(await page.locator(".game-card.locked").count(), 4, "开局只该解锁第 1 关");
await page.locator(".game-card").first().click();
await page.waitForURL(/\/child\/games\/klotski\?level=1$/);
await page.locator(".klotski-piece").first().waitFor();
assert.equal(await page.locator(".klotski-piece").count(), 10);
// 出口必须有常驻标记：底行正中的虚线落区（带「出口」二字）+ 底边缺口。
assert.equal(await page.locator(".klotski-exit").innerText(), "出口", "棋盘上没有出口落区");
assert.equal(await page.locator(".klotski-exit-notch").count(), 1, "棋盘底边没有出口缺口");
// 选中态各验一次：点棋子挂上 .selected，再点一下收起。
await page.locator('[data-piece="q"]').click();
assert.equal(await page.locator(".klotski-piece.selected").count(), 1);
await page.locator('[data-piece="q"]').click();
assert.equal(await page.locator(".klotski-piece.selected").count(), 0);
// 提示贴住当前局面：开局点一下，客户端 BFS 现算出第一步与剩余最少步数；
// 「第 X 步 / 最少 N 步」的 N 来自服务端下发的同一份 BFS 下限。
assert.ok(
  (await page.locator(".klotski-steps").innerText()).includes("最少 118 步"),
  "步数角标没带下发的最少步数",
);
const hintButton = page.getByRole("button", { name: "提示", exact: true });
await hintButton.click();
const hintText = await page.locator(".klotski-hint").innerText();
assert.match(hintText, /下一步：空[12] 向[上下左右]滑/, "提示没有按空格记法给出下一步");
assert.ok(/最少还需 118 步/.test(hintText), "开局提示应说最少还需 118 步");
// 提示不只写在文字里，还画在盘上：恰好一块棋子挂 .hint-from（带方向箭头徽标），
// 恰好一个落点框 .hint-cell 盖住空格——孩子照盘上高亮走即可，不必换算「空几」。
assert.equal(await page.locator(".klotski-piece.hint-from").count(), 1, "盘面没有高亮该动的棋子");
assert.equal(await page.locator(".hint-arrow").count(), 1, "该动的棋子上没有方向箭头");
assert.ok(["up", "down", "left", "right"].includes(await page.locator(".hint-arrow").getAttribute("data-dir") ?? ""), "箭头没有方向");
assert.equal(await page.locator(".hint-cell").count(), 1, "盘面没有标出滑动落点");
await page.getByRole("button", { name: "看完整走法" }).click();
assert.equal(await page.locator(".klotski-steps-list li").count(), 118, "完整走法不是 118 条");
await page.getByRole("button", { name: "收起走法" }).click();
assert.equal(await page.locator(".klotski-steps-list").count(), 0, "走法列表没有收起");
// 走到一步就作废：手动走脚本的第一步，提示条必须跟着消失，随后脚本走完剩下的 117 步。
await page.locator('[data-piece="q"]').click();
await page.locator('.movable-target[data-anchor="3,1"]').first().click();
await page.locator(".klotski-hint").waitFor({ state: "detached" });
await hintButton.click();
assert.match(
  await page.locator(".klotski-hint").innerText(),
  /最少还需 117 步/,
  "走一步后提示没有重算剩余步数",
);
// 断点存档：走一步就自动存下盘面，重新载入这一屏必须接着上一手，而不是从头。
const saveFor = async (slot) => {
  const payload = await page.evaluate(async () =>
    (await fetch("/api/v1/games/saves", { credentials: "same-origin" })).json(),
  );
  return payload.saves.find((save) => save.game === slot) ?? null;
};
// 存盘是异步的：离开页面前等它真的落地，否则续玩断言会读到上一手的状态。
const waitForSave = async (slot, ok) => {
  for (let i = 0; i < 100; i++) {
    const save = await saveFor(slot);
    if (save && ok(save.state)) return save;
    await page.waitForTimeout(50);
  }
  throw new Error(`断点没有在 5 秒内写入：${slot}`);
};
const savedLevel1 = await saveFor("klotski:1");
assert.ok(savedLevel1, "走了一步却没有留下断点");
assert.equal(savedLevel1.state.steps, 1, "断点没有记下这一步");
assert.equal(savedLevel1.state.history.length, 1, "断点没有带上撤销栈");
await page.reload();
await settleRewards();
await page.locator(".klotski-piece").first().waitFor();
await page.locator(".klotski-restored").waitFor();
assert.ok(
  (await page.locator(".klotski-restored").innerText()).includes("第 1 步"),
  "恢复提示没有报出恢复到的步数",
);
assert.ok(
  (await page.locator(".klotski-steps").innerText()).includes("第 1 步"),
  "恢复后的盘面不在第 1 步",
);
// 重置已经离开工具栏（不再紧贴「提示」），改到页面底部且先弹确认。
assert.equal(
  await page.getByRole("button", { name: "重置", exact: true }).count(),
  0,
  "工具栏里还留着重置按钮",
);
const restartButton = page.getByRole("button", { name: "重新开始本关", exact: true });
await restartButton.click();
const restartModal = page.getByRole("dialog", { name: "重新开始本关" });
await restartModal.waitFor();
await restartModal.getByRole("button", { name: "再想想" }).click();
await restartModal.waitFor({ state: "detached" });
assert.ok(
  (await page.locator(".klotski-steps").innerText()).includes("第 1 步"),
  "取消了确认却把盘面清了",
);
await restartButton.click();
await page
  .getByRole("dialog", { name: "重新开始本关" })
  .getByRole("button", { name: "重新开始" })
  .click();
await page.locator(".klotski-restored").waitFor({ state: "detached" });
assert.ok(
  (await page.locator(".klotski-steps").innerText()).includes("第 0 步"),
  "确认重新开始后盘面没有回到初始",
);
assert.equal(await saveFor("klotski:1"), null, "重新开始后断点还留着");
// 真通关之前先撞三堵墙：步数低于第 1 关最短解 118 → 400；第 2 关还没解锁就报通关
// → 409；不存在的关卡 → 404。探针窗口内放行这三个 URL 的 console 噪声。
expectKlotskiProbe = true;
const klotskiProbes = await page.evaluate(async () => {
  const post = async (level, moves) => {
    const response = await fetch(`/api/v1/games/klotski/${level}/complete`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves }),
    });
    return response.status;
  };
  return [await post(1, 50), await post(2, 120), await post(6, 120)];
});
expectKlotskiProbe = false;
assert.deepEqual(klotskiProbes, [400, 409, 404], "非法通关上报没有各回各的 400/409/404");
const probeState = await getState();
assert.equal(
  probeState.children.find((c) => c.id === probeState.activeChildId).pointsBalance,
  gameBalance,
  "探针在没通关之前不该动余额",
);
// 按棋盘走一遍最短解：每步 = 点棋子、再点亮起的空位（data-anchor 是落点锚坐标）。
// 宽棋子一次滑出新占两格时会有两个同 anchor 的圆点——它们就是同一次滑动，点哪个都一样。
async function playKlotski(moves) {
  for (const [piece, anchorRow, anchorCol] of moves) {
    await page.locator(`[data-piece="${piece}"]`).click();
    await page
      .locator(`.movable-target[data-anchor="${anchorRow},${anchorCol}"]`)
      .first()
      .click();
  }
}
async function closeKlotskiBanner() {
  const banner = page.locator(".reward-celebration");
  await banner.getByText("游戏奖励", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await banner.locator("strong").innerText(), "+30 积分到账！");
  await banner.getByRole("button", { name: "关闭积分到账提示" }).click();
  await banner.waitFor({ state: "detached" });
}
const completeLevel1 = page.waitForResponse((response) =>
  response.url().endsWith("/api/v1/games/klotski/1/complete"),
);
await playKlotski(klotskiLevel1);
assert.equal((await completeLevel1).status(), 200, "第 1 关最短解没有被服务端接受");
const winModal = page.getByRole("dialog", { name: "通关成功" });
await winModal.waitFor();
// +30 胶囊只画服务端回的值，和弹窗同一次渲染挂出来。
assert.equal(await page.locator(".klotski-award").innerText(), "+30");
await closeKlotskiBanner();
const gameFirst = await waitForState(
  (s) =>
    s.children.find((c) => c.id === s.activeChildId).pointsBalance === gameBalance + 30,
);
// 通关的那一手就把断点清了：再进这一关不该恢复成一个已经赢了的盘面。
assert.equal(await saveFor("klotski:1"), null, "通关后断点还留着");
assert.ok(
  gameFirst.ledger.some(
    (item) =>
      item.childId === gameFirst.activeChildId &&
      item.referenceType === "game" &&
      item.amount === 30 &&
      item.description === "通关华容道：横刀立马",
  ),
  "首通没有按 game 台账记到账",
);
await winModal.getByRole("button", { name: "再玩一次" }).click();
await page.getByRole("link", { name: "返回关卡列表" }).click();
await page.waitForURL(/\/child\/games$/);
await page.locator(".game-card").first().waitFor();
assert.equal(await page.locator(".game-card.locked").count(), 3, "通关第 1 关应解锁第 2 关");
assert.ok(
  (await page.locator(".game-card").first().innerText()).includes("已通关 · 最少 118 步"),
  "第 1 关卡片没记下最少步数",
);
// 第 2 关同样真打（89 步最短解），顺带验证弹窗的下一段旅程也走得通。
await page.locator(".game-card").nth(1).click();
await page.waitForURL(/\/child\/games\/klotski\?level=2$/);
await page.locator(".klotski-piece").first().waitFor();
const completeLevel2 = page.waitForResponse((response) =>
  response.url().endsWith("/api/v1/games/klotski/2/complete"),
);
await playKlotski(klotskiLevel2);
assert.equal((await completeLevel2).status(), 200);
const winModal2 = page.getByRole("dialog", { name: "通关成功" });
await winModal2.waitFor();
await closeKlotskiBanner();
await waitForState(
  (s) =>
    s.children.find((c) => c.id === s.activeChildId).pointsBalance === gameBalance + 60,
);
await winModal2.getByRole("button", { name: "再玩一次" }).click();
await page.getByRole("link", { name: "返回关卡列表" }).click();
await page.waitForURL(/\/child\/games$/);
await page.locator(".game-card").first().waitFor();
assert.equal(await page.locator(".game-card.locked").count(), 2, "通关第 2 关应解锁第 3 关");
await page.getByRole("link", { name: "今日", exact: true }).click();
assert.ok((await gameTeaser.innerText()).includes("已通关 2/5"));
// 重放只在更好时刷纪录：120 > 89 是合法但更差的一报，不再发分也不动纪录。
expectKlotskiProbe = true;
const worseReplay = await page.evaluate(async () => {
  const response = await fetch("/api/v1/games/klotski/2/complete", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moves: 120 }),
  });
  return [response.status, (await response.json()).awarded];
});
expectKlotskiProbe = false;
assert.deepEqual(worseReplay, [200, 0], "更差的重放不该再发分");
const klotskiProgress = await page.evaluate(async () =>
  (await fetch("/api/v1/games/klotski", { credentials: "same-origin" })).json(),
);
assert.equal(klotskiProgress.completed, 2);
assert.equal(klotskiProgress.levels[0].bestMoves, 118);
assert.equal(klotskiProgress.levels[1].bestMoves, 89, "更差的重放把纪录改坏了");
assert.equal(klotskiProgress.levels[1].completed, true);
assert.equal(klotskiProgress.levels[2].unlocked, true);
assert.equal(klotskiProgress.levels[2].completed, false);
assert.equal(klotskiProgress.levels[3].unlocked, false);
await page.screenshot({ path: ".artifacts/ui/games-progress.png", fullPage: true });
// ── 口算闯关 + 找规律：?seed= 固定出题，harness 在页面里重算正确答案点下去；
// 每一局都按本局得分全额入账（不看纪录），所以三局一组：3 题 +3、平纪录再来 3 题
// 再 +3、5 题 +5。找规律再故意错一题，验证 10 分制和失误扣的是题分。
const quizBalance = gameBalance + 60;
const clickChoice = (value) =>
  page.locator(".quiz-choice").filter({ hasText: new RegExp(`^\\s*${value}\\s*$`) }).click();
const calcAnswer = () =>
  page.evaluate(() => {
    const m = document
      .querySelector(".quiz-problem")
      .textContent.match(/(\d+)\s*([+\-×÷])\s*(\d+)/);
    const a = Number(m[1]);
    const b = Number(m[3]);
    return String(
      m[2] === "+" ? a + b : m[2] === "-" ? a - b : m[2] === "×" ? a * b : a / b,
    );
  });
async function closeQuizBanner(amount) {
  const banner = page.locator(".reward-celebration");
  await banner.getByText("游戏奖励", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await banner.locator("strong").innerText(), `+${amount} 积分到账！`);
  await banner.getByRole("button", { name: "关闭积分到账提示" }).click();
  await banner.waitFor({ state: "detached" });
}
async function answerCalcRound(correct) {
  for (let i = 0; i < correct; i++) {
    await clickChoice(await calcAnswer());
    await page.waitForTimeout(500);
  }
  const reported = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/games/quizzes/timed_calc/score"),
  );
  await page.getByRole("button", { name: "交卷" }).click();
  assert.equal((await reported).status(), 200, "口算成绩没有被服务端接受");
}
await page.getByRole("link", { name: "进入游戏" }).click();
await page.waitForURL(/\/child\/games$/);
await page.getByRole("button", { name: /^口算闯关/ }).click();
await page.waitForURL(/\/child\/games\/calc$/);
// 断点续玩：先开一局答对 1 题，离开这一屏再回来，必须能从第 1 档的 1 题接着。
await page.goto(baseUrl + "/child/games/calc?seed=777");
await settleRewards();
await page.getByRole("button", { name: "第1档 · 20 以内加减" }).click();
await page.locator(".quiz-problem").waitFor();
await clickChoice(await calcAnswer());
await page.waitForTimeout(500);
// 等一次倒计时滴答：剩 60 秒和剩 59 秒在界面上分不出「接上」还是「重开」。
await waitForSave("timed_calc", (state) => state.score === 1 && state.seconds < 60);
await page.goto(baseUrl + "/child/games");
await settleRewards();
await page.getByRole("button", { name: /^口算闯关/ }).click();
await page.waitForURL(/\/child\/games\/calc$/);
const resumeCalc = page.getByRole("button", {
  name: /^继续上次（第 1 档 · 已答对 1 题 · 剩 \d+ 秒）/,
});
await resumeCalc.waitFor();
await resumeCalc.click();
await page.locator(".quiz-problem").waitFor();
assert.ok(
  (await page.locator(".quiz-meta").innerText()).includes("答对 1 题"),
  "续玩没有接上已答对的题数",
);
const resumedSeconds = Number((await page.locator(".quiz-timer").innerText()).replace(/\D/g, ""));
assert.ok(
  resumedSeconds > 0 && resumedSeconds < 60,
  `续玩没有接上剩余秒数：${resumedSeconds}`,
);
await page.goto(baseUrl + "/child/games/calc?seed=777");
await settleRewards();
await page.getByRole("button", { name: "第1档 · 20 以内加减" }).click();
await page.locator(".quiz-problem").waitFor();
// 第 1 局：答对 3 题就交卷 → +3 与横幅。
const calcReport1 = page.waitForResponse((response) =>
  response.url().endsWith("/api/v1/games/quizzes/timed_calc/score"),
);
await answerCalcRound(3);
await calcReport1;
await page.locator(".quiz-result").waitFor();
assert.equal(await page.locator(".quiz-result strong").innerText(), "3");
assert.ok(
  (await page.locator(".quiz-record").innerText()).includes("+3"),
  "首局记分没在结算里报出本局获得的积分",
);
await closeQuizBanner(3);
await waitForState(
  (s) =>
    s.children.find((c) => c.id === s.activeChildId).pointsBalance === quizBalance + 3,
);
// 第 2 局同种子同 3 题：不破纪录也照样记 +3，横幅照弹。
await page.getByRole("button", { name: "再来一局" }).click();
await page.locator(".quiz-problem").waitFor();
await answerCalcRound(3);
await page.locator(".quiz-result").waitFor();
assert.ok(
  (await page.locator(".quiz-record").innerText()).includes("+3"),
  "平纪录的一局没有按本局得分记积分",
);
await closeQuizBanner(3);
await waitForState(
  (s) =>
    s.children.find((c) => c.id === s.activeChildId).pointsBalance === quizBalance + 6,
);
// 第 3 局答到 5：还是本局全额 +5（不是差价），最好成绩跟着变成 5。
await page.getByRole("button", { name: "再来一局" }).click();
await page.locator(".quiz-problem").waitFor();
await answerCalcRound(5);
await page.locator(".quiz-result").waitFor();
assert.equal(await page.locator(".quiz-result strong").innerText(), "5");
await closeQuizBanner(5);
// 找规律：错一题只扣那一题的 10 分 → 90 分补 9。
await page.getByRole("link", { name: "返回关卡列表" }).click();
await page.waitForURL(/\/child\/games$/);
await page.getByRole("button", { name: /^找规律/ }).click();
await page.waitForURL(/\/child\/games\/pattern$/);
await page.goto(baseUrl + "/child/games/pattern?seed=4242");
await settleRewards();
await page.getByRole("button", { name: "开始找规律" }).click();
await page.locator(".pattern-seq").waitFor();
const patternAnswer = () =>
  page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".pattern-seq .pattern-tile")].map((t) =>
      t.textContent.trim(),
    );
    const seq = tiles.slice(0, -1);
    if (seq.some((s) => !/^\d+$/.test(s))) {
      const cycle = seq[0] === seq[2] && seq[1] === seq[3] ? 2 : 3;
      if (!(seq[0] === seq[cycle] && seq[1] === seq[cycle + 1]))
        throw new Error("no cycle in " + seq.join(","));
      return seq[5 % cycle];
    }
    const nums = seq.map(Number);
    if (nums.every((v, i) => i === 0 || v === nums[i - 1] * 2)) return String(nums[4] * 2);
    const diffs = nums.slice(1).map((v, i) => v - nums[i]);
    if (diffs.every((d) => d === diffs[0])) return String(nums[4] + diffs[0]);
    if (diffs.slice(1).every((d, i) => d - diffs[i] === 1))
      return String(nums[4] + diffs[3] + 1);
    throw new Error("unknown pattern " + nums.join(","));
  });
async function answerPatternRound({ firstWrong }) {
  for (let q = 0; q < 10; q++) {
    const answer = await patternAnswer();
    const choices = (
      await page.locator(".pattern-choices .quiz-choice").allInnerTexts()
    ).map((t) => t.trim());
    assert.ok(choices.includes(answer), "这一题的正确答案不在选项里：" + answer);
    if (q === 0 && firstWrong) {
      const wrong = choices.find((t) => t !== answer);
      await page
        .locator(".pattern-choices .quiz-choice")
        .filter({ hasText: new RegExp(`^\\s*${wrong}\\s*$`) })
        .click();
      assert.equal(
        await page.locator(".quiz-choice.wrong").count(),
        1,
        "点错后没有画出错误反馈",
      );
    } else {
      await page
        .locator(".pattern-choices .quiz-choice")
        .filter({ hasText: new RegExp(`^\\s*${answer}\\s*$`) })
        .click();
    }
    await page.waitForTimeout(500);
  }
  await page.locator(".quiz-result").waitFor();
}
// 断点续玩（找规律）：存的是种子 + 题号 + 失误数，所以答完第 1 题离开、再回来
// 必须接在第 2 题上，而不是从头。这一局不交卷，只验证存档。
const firstPatternAnswer = await patternAnswer();
await page
  .locator(".pattern-choices .quiz-choice")
  .filter({ hasText: new RegExp(`^\\s*${firstPatternAnswer}\\s*$`) })
  .click();
await page.waitForTimeout(500);
await waitForSave("pattern_quiz", (state) => state.index === 1);
await page.goto(baseUrl + "/child/games");
await settleRewards();
await page.getByRole("button", { name: /^找规律/ }).click();
await page.waitForURL(/\/child\/games\/pattern$/);
const resumePattern = page.getByRole("button", { name: "继续上次（第 2 / 10 题）" });
await resumePattern.waitFor();
await resumePattern.click();
await page.locator(".pattern-seq").waitFor();
assert.ok(
  (await page.locator(".quiz-meta").innerText()).includes("第 2 / 10 题"),
  "续玩没有接上题号",
);
// 续玩验证完就重新开一局，让下面那轮从第 1 题开始（故意错一题）。
await page.goto(baseUrl + "/child/games/pattern?seed=4242");
await settleRewards();
await page.getByRole("button", { name: "开始找规律" }).click();
await page.locator(".pattern-seq").waitFor();
const patternReport1 = page.waitForResponse((response) =>
  response.url().endsWith("/api/v1/games/quizzes/pattern_quiz/score"),
);
await answerPatternRound({ firstWrong: true });
assert.equal((await patternReport1).status(), 200, "找规律成绩没有被服务端接受");
assert.ok(
  (await page.locator(".quiz-result").innerText()).includes("90"),
  "错一题没有按 10 分制扣成 90",
);
await closeQuizBanner(9);
// 全对 → 100 分记 10 积分（10 分制折 1）；再全对一次 → 还是 10。
await page.getByRole("button", { name: "再来一局" }).click();
await page.locator(".pattern-seq").waitFor();
await answerPatternRound({ firstWrong: false });
await closeQuizBanner(10);
await page.getByRole("button", { name: "再来一局" }).click();
await page.locator(".pattern-seq").waitFor();
await answerPatternRound({ firstWrong: false });
assert.ok(
  (await page.locator(".quiz-record").innerText()).includes("+10"),
  "平纪录的找规律一局没有按本局得分记积分",
);
await closeQuizBanner(10);
// 台账六笔：口算 +3/+3/+5、找规律 +9/+10/+10（百分制折 10:1），描述带本局成绩。
const quizState = await waitForState(
  (s) =>
    s.children.find((c) => c.id === s.activeChildId).pointsBalance ===
    quizBalance + 40,
);
for (const [desc, amount] of [
  ["口算闯关：3 题", 3],
  ["口算闯关：3 题", 3],
  ["口算闯关：5 题", 5],
  ["找规律：90 分", 9],
  ["找规律：100 分", 10],
  ["找规律：100 分", 10],
])
  assert.ok(
    quizState.ledger.some(
      (item) =>
        item.childId === quizState.activeChildId &&
        item.referenceType === "game" &&
        item.description === desc &&
        item.amount === amount,
    ),
    `台账里少了「${desc}」这一笔`,
  );
// 非法上报探针：没带幂等键、分数超量表、不存在的游戏。
expectQuizProbe = true;
const quizProbes = await page.evaluate(async () => {
  const post = async (game, body, key) =>
    (
      await fetch(`/api/v1/games/quizzes/${game}/score`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        body: JSON.stringify(body),
      })
    ).status;
  return [
    await post("timed_calc", { score: 3, level: 1, seconds: 60 }),
    await post("timed_calc", { score: 99, level: 1, seconds: 60 }, "probe-calc"),
    await post("snake_sort", { score: 1, level: 1, seconds: 60 }, "probe-game"),
  ];
});
expectQuizProbe = false;
assert.deepEqual(quizProbes, [400, 400, 404], "三个非法上报的分支码不对");
// 关卡列表把今天的最好成绩写在卡上。
await page.getByRole("link", { name: "返回关卡列表" }).click();
await page.waitForURL(/\/child\/games$/);
await page.locator(".game-card").first().waitFor();
assert.ok(
  (await page.getByRole("button", { name: /^口算闯关/ }).innerText()).includes("今天最好 5 题"),
  "口算卡片没记下今天的最好成绩",
);
assert.ok(
  (await page.getByRole("button", { name: /^找规律/ }).innerText()).includes("今天最好 100 分"),
  "找规律卡片没记下今天的最好成绩",
);
// 家长端只读进度：五关 + 两个题类游戏都在，状态和孩子端一致。
await enterParent(false, "1357");
await page.getByRole("link", { name: "游戏进度" }).click();
await page.waitForURL(/\/parent\/games$/);
await page.locator(".game-admin-row").first().waitFor();
assert.equal(await page.locator(".game-admin-row").count(), 7, "五关华容道 + 两个题类游戏共 7 行");
const firstAdminRow = page.locator(".game-admin-row").first();
assert.ok((await firstAdminRow.innerText()).includes("已通关"));
assert.ok((await firstAdminRow.innerText()).includes("最少 118 步"));
assert.ok(
  (await page.locator(".game-admin-row").nth(4).innerText()).includes("未解锁"),
  "第 5 关在未解锁列表里显示错了",
);
assert.ok(
  (await page.locator(".game-admin-row").nth(5).innerText()).includes("今天最好 5 · 历史最好 5"),
  "家长端口算进度不对",
);
assert.ok(
  (await page.locator(".game-admin-row").nth(6).innerText()).includes("今天最好 100 · 历史最好 100"),
  "家长端找规律进度不对",
);
await page.screenshot({ path: ".artifacts/ui/games-admin.png", fullPage: true });
await enterChild();

// ── 家庭作业：家长录入（学科 + 文字 + 图片）→ 孩子端当天可见、谚语带拼音、灯箱可左右
// 切换（含首尾循环与滑动）→ 家长改删。家长密码此刻已经是上面改过的 1357。
await enterParent(false, "1357");
await page.getByRole("link", { name: "作业管理" }).click();
await page.waitForURL(/\/parent\/homework$/);
await page.getByRole("button", { name: "新增作业" }).click();
const homeworkModal = page.locator(".form-modal");
await homeworkModal.waitFor();
await homeworkModal.getByRole("button", { name: "语文" }).click();
await homeworkModal.getByLabel("文字描述").fill("抄写第三课生字各三遍，明天听写。");
await homeworkModal.locator('input[type="file"]').setInputFiles([
  { name: "homework-a.png", mimeType: "image/png", buffer: proofPng },
  { name: "homework-b.png", mimeType: "image/png", buffer: proofPng },
]);
await homeworkModal.getByText("已选 2 个文件 · 点击更换").waitFor();
// 提交前的本地预览必须真的解出选中的图（PRD §3.2 的实时预览），顺便保证截图不是空框。
await assertRealImage(
  homeworkModal.locator(".upload-preview img").first(),
  proofSize,
);
await page.screenshot({
  path: ".artifacts/ui/homework-form.png",
  fullPage: true,
});
await homeworkModal.getByRole("button", { name: "保存作业" }).click();
await page.locator(".form-modal").waitFor({ state: "detached" });
await page.getByText("作业已保存").waitFor();
const homeworkRow = page
  .locator(".homework-admin-row")
  .filter({ hasText: "语文" });
await homeworkRow.waitFor();
assert.ok((await homeworkRow.innerText()).includes("抄写第三课生字各三遍"));
assert.ok((await homeworkRow.innerText()).includes("2 个附件"));

await enterChild();
// 首页（/）就有今日作业模块：录入的作业不点 tab 也看得见，谚语横幅跟着一起上首页。
const homeModule = page.locator(".homework-module");
await homeModule
  .locator(".homework-card")
  .filter({ hasText: "抄写第三课生字各三遍" })
  .waitFor();
assert.ok((await homeModule.locator(".proverb-banner").innerText()).includes("每日谚语"));
await page.getByRole("link", { name: "作业" }).click();
await page.waitForURL(/\/child\/homework$/);
const banner = page.locator(".proverb-banner");
await banner.waitFor();
assert.ok((await banner.innerText()).includes("每日谚语"));
assert.ok((await banner.locator("rt").first().innerText()).length > 0);
assert.ok((await banner.locator(".proverb-english").innerText()).length > 0);
// 霞鹜文楷是自托管分包：字体真的从 /fonts 加载出来，check() 才是 true。
await page.evaluate(() => document.fonts.ready);
assert.equal(
  await page.evaluate(() => document.fonts.check('16px "LXGW WenKai GB"')),
  true,
);
const homeworkCard = page
  .locator(".homework-card")
  .filter({ hasText: "抄写第三课生字各三遍" });
await homeworkCard.waitFor();
assert.ok(
  (await homeworkCard.locator(".subject-chip").innerText()).includes("语文"),
);
assert.ok(
  (await homeworkCard.locator(".homework-desc").innerText()).includes(
    "抄写第三课生字各三遍",
  ),
);
const homeworkThumb = homeworkCard.locator(".homework-thumb img").first();
await assertRealImage(homeworkThumb, proofSize);
// 勾上完成的即时反馈：那张卡立刻标出加了几分，余额真的涨同样多；取消完成则徽章消失、
// 只留一条退回提示（服务端 awarded 是双向的）。
const pointsBalance = async () =>
  await page.evaluate(
    async () =>
      (await (await fetch("/api/v1/state")).json()).children[0].pointsBalance,
  );
const balanceBeforeTick = await pointsBalance();
await homeworkCard.locator(".homework-check input").check();
const awardedText = (await homeworkCard.locator(".homework-award").textContent())?.trim();
assert.match(awardedText ?? "", /^\+\d+$/);
assert.equal(
  (await pointsBalance()) - balanceBeforeTick,
  Number(awardedText?.slice(1)),
);
await homeworkCard.locator(".homework-check input").uncheck();
await homeworkCard.locator(".homework-award").waitFor({ state: "detached" });
assert.equal(await pointsBalance(), balanceBeforeTick);
const undoToast = page.locator(".app-toast").filter({ hasText: "已取消完成，扣回" });
await undoToast.waitFor();
await page.getByRole("button", { name: "关闭提示" }).click();
await homeworkCard.locator(".homework-check input").check();
assert.equal(await homeworkCard.locator(".homework-check input").isChecked(), true);
const viewer = page.locator(".homework-viewer");
const viewerCount = async () =>
  (await viewer.locator(".viewer-count").innerText()).trim();
const fireTouch = async (type, x) => {
  await page.evaluate(
    ([kind, clientX]) => {
      const stage = document.querySelector(".homework-viewer .viewer-stage");
      const event = new Event(kind, { bubbles: true });
      Object.defineProperty(event, "touches", {
        value: [{ clientX, clientY: 300 }],
      });
      Object.defineProperty(event, "changedTouches", {
        value: [{ clientX, clientY: 300 }],
      });
      stage.dispatchEvent(event);
    },
    [type, x],
  );
};
await homeworkThumb.click();
await viewer.waitFor();
assert.equal(await viewerCount(), "1 / 2");
await viewer.getByRole("button", { name: "下一张" }).click();
assert.equal(await viewerCount(), "2 / 2");
// 首尾循环：最后一张再往后回到第一张。
await viewer.getByRole("button", { name: "下一张" }).click();
assert.equal(await viewerCount(), "1 / 2");
await fireTouch("touchstart", 320);
await fireTouch("touchend", 180);
assert.equal(await viewerCount(), "2 / 2");
await fireTouch("touchstart", 180);
await fireTouch("touchend", 320);
assert.equal(await viewerCount(), "1 / 2");
// 触摸滑动之后浏览器还会补一次 click：那一次必须被吞掉，否则一划就关。
await page.evaluate(() => {
  document
    .querySelector(".homework-viewer")
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
assert.ok(await viewer.isVisible());
// 缩放按钮：放大后 data-scale > 1，重置回到 1。
const zoomScale = () =>
  viewer.locator(".zoomable-image").evaluate((img) => Number(img.getAttribute("data-scale")));
assert.equal(await zoomScale(), 1);
await viewer.getByRole("button", { name: "放大" }).click();
assert.ok((await zoomScale()) > 1);
await viewer.getByRole("button", { name: "重置" }).click();
assert.equal(await zoomScale(), 1);
await viewer.getByRole("button", { name: "关闭预览" }).click();
await viewer.waitFor({ state: "detached" });
// 日期导航：前一天没有作业 → 空状态，标题改成日期，但谚语仍然在。
await page.getByRole("button", { name: "前一天" }).click();
await page.locator(".empty-state").waitFor();
assert.ok(
  (await page.locator(".homework-head h1").innerText()).includes("· 作业"),
);
assert.ok(await page.locator(".proverb-banner").isVisible());
await page.getByRole("button", { name: "回到今天" }).click();
await page
  .locator(".homework-card")
  .filter({ hasText: "抄写第三课生字各三遍" })
  .waitFor();
assert.ok(
  (await page.locator(".homework-head h1").innerText()).includes("今日作业"),
);
// 首页模块永远看今天：刚在作业页翻到前一天，回首页看到的仍是今天的作业；模块的
// 「按日期查看」把用户送到作业页。
await page.getByRole("button", { name: "前一天" }).click();
await page.locator(".empty-state").waitFor();
await page.getByRole("link", { name: "今日", exact: true }).click();
await page.waitForURL(/\/child$/);
await page
  .locator(".homework-module .homework-card")
  .filter({ hasText: "抄写第三课生字各三遍" })
  .waitFor();
await page.getByRole("link", { name: "按日期查看" }).click();
await page.waitForURL(/\/child\/homework$/);
await page
  .locator(".homework-card")
  .filter({ hasText: "抄写第三课生字各三遍" })
  .waitFor();

await enterParent(false, "1357");
await page.getByRole("link", { name: "作业管理" }).click();
await page.waitForURL(/\/parent\/homework$/);
await page.getByRole("button", { name: "编辑语文" }).click();
const editHomeworkModal = page.locator(".form-modal");
await editHomeworkModal.getByRole("button", { name: "删除homework-a.png" }).click();
await editHomeworkModal.getByRole("button", { name: "保存作业" }).click();
await page.locator(".form-modal").waitFor({ state: "detached" });
await page.getByText("作业已保存").waitFor();
await page
  .locator(".homework-admin-row")
  .filter({ hasText: "1 个附件" })
  .waitFor();
await page.getByRole("button", { name: "删除语文" }).click();
await page.getByRole("button", { name: "确认删除" }).click();
await page.getByText("作业已删除").waitFor();
await page.locator(".homework-admin-row").waitFor({ state: "detached" });
// 孩子端这一天跟着空了，首页模块也回到空状态。
await enterChild();
await page.getByRole("link", { name: "作业" }).click();
await page.waitForURL(/\/child\/homework$/);
await page.locator(".empty-state").waitFor();
await page.getByRole("link", { name: "今日", exact: true }).click();
await page.waitForURL(/\/child$/);
const emptyHomeModule = page.locator(".homework-module .empty-state");
await emptyHomeModule.waitFor();
assert.ok((await emptyHomeModule.innerText()).includes("今日暂无作业"));
assert.ok((await page.locator(".homework-module").innerText()).includes("按日期查看"));

// ── 假期作业：在假期前一天设一次，整段假期每天都能看到。
// 起始日现探：取未来 90 天里第一个「首日就是这天、且还能延续」的连续假期块，
// 所以门不依赖具体年份的放假表，也不会撞上落在假期内或后接调休上班的周五。
const holidayPlan = await page.evaluate(async () => {
  const state = await (await fetch("/api/v1/state")).json();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: state.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  const today = new Date(
    `${value("year")}-${value("month")}-${value("day")}T00:00:00Z`,
  );
  for (let ahead = 1; ahead <= 90; ahead += 1) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() + ahead);
    const date = day.toISOString().slice(0, 10);
    const response = await fetch(`/api/v1/homework/?date=${date}`);
    const holiday = (await response.json()).holiday;
    if (!holiday || holiday.start !== date || holiday.end === date) continue;
    // 第二天也要认出同一个块：周末块的首日若是周五，周六读到的只是它自己的
    // 2 天块（周五是「假前日」），表单就不会预填整段了。
    const nextDay = new Date(day);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const next = await fetch(
      `/api/v1/homework/?date=${nextDay.toISOString().slice(0, 10)}`,
    );
    if ((await next.json()).holiday?.start === date) return holiday;
  }
  return null;
});
assert.ok(holidayPlan, "未来 90 天里应至少有一段连续假期");
const shiftDay = (date, days) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
};
const holidayStart = holidayPlan.start;
const midHoliday = shiftDay(holidayStart, 1);
const openHomeworkDay = async (date) => {
  const loaded = page.waitForResponse((response) =>
    response.url().includes(`/api/v1/homework/?date=${date}`),
  );
  await page.getByLabel("作业日期").fill(date);
  await loaded;
};

await enterParent(false, "1357");
await page.getByRole("link", { name: "作业管理" }).click();
await page.waitForURL(/\/parent\/homework$/);
await openHomeworkDay(holidayStart);
await page.getByRole("button", { name: "新增作业" }).click();
const holidayModal = page.locator(".form-modal");
await holidayModal.waitFor();
// 表单已经预填整段假期，家长只需要点保存。
assert.equal(
  await holidayModal.getByLabel("日期", { exact: true }).inputValue(),
  holidayStart,
);
assert.equal(
  await holidayModal.getByLabel("结束日期").inputValue(),
  holidayPlan.end,
);
assert.ok(
  (await holidayModal.locator(".holiday-hint").innerText()).includes(
    holidayPlan.name,
  ),
);
await holidayModal.getByRole("button", { name: "数学" }).click();
await holidayModal
  .getByLabel("文字描述")
  .fill("假期里每天读十页课外书。");
await page.screenshot({
  path: ".artifacts/ui/homework-holiday.png",
  fullPage: true,
});
await holidayModal.getByRole("button", { name: "保存作业" }).click();
await page.locator(".form-modal").waitFor({ state: "detached" });
await page.getByText("作业已保存").waitFor();
const holidayRow = page
  .locator(".homework-admin-row")
  .filter({ hasText: "假期里每天读十页课外书" });
await holidayRow.locator(".holiday-badge").waitFor();
assert.ok((await holidayRow.locator(".holiday-badge").innerText()).includes("假期作业"));

// 在假期中间新增也要预填整段范围（否则 10/3 新增就只有 10/3–10/7）。
await openHomeworkDay(midHoliday);
await page.getByRole("button", { name: "新增作业" }).click();
const midModal = page.locator(".form-modal");
await midModal.waitFor();
assert.equal(
  await midModal.getByLabel("日期", { exact: true }).inputValue(),
  holidayStart,
);
assert.equal(
  await midModal.getByLabel("结束日期").inputValue(),
  holidayPlan.end,
);
assert.ok(
  (await midModal.locator(".holiday-hint").innerText()).includes(
    holidayPlan.name,
  ),
);
await midModal.locator(".form-heading button").click();
await page.locator(".form-modal").waitFor({ state: "detached" });

await enterChild();
await page.getByRole("link", { name: "作业" }).click();
await page.waitForURL(/\/child\/homework$/);
// 假期每一天都看得到同一条作业，超出范围就看不到。
const holidayDays = [];
for (
  let day = holidayStart;
  day <= holidayPlan.end;
  day = shiftDay(day, 1)
) {
  holidayDays.push(day);
}
assert.ok(holidayDays.length > 1);
for (const date of holidayDays) {
  const loaded = page.waitForResponse((response) =>
    response.url().includes(`/api/v1/homework/?date=${date}`),
  );
  await page.getByLabel("选择日期").fill(date);
  await loaded;
  const holidayCard = page
    .locator(".homework-card")
    .filter({ hasText: "假期里每天读十页课外书" });
  await holidayCard.waitFor();
  assert.ok(
    (await holidayCard.locator(".holiday-badge").innerText()).includes(
      "假期作业",
    ),
  );
}
const afterHoliday = shiftDay(holidayPlan.end, 1);
const afterLoaded = page.waitForResponse((response) =>
  response.url().includes(`/api/v1/homework/?date=${afterHoliday}`),
);
await page.getByLabel("选择日期").fill(afterHoliday);
await afterLoaded;
await page.locator(".homework-card").waitFor({ state: "detached" });
await page.locator(".empty-state").waitFor();
await page.getByRole("link", { name: "今日", exact: true }).click();
await page.waitForURL(/\/child$/);

// 顶栏刷新：数据往往和屏幕上一样，所以必须给一句回执，否则按钮看起来没反应；
// 这条提示只认「已刷新」自己，2 秒后自收（别把后来换成别的提示的消息一起清掉）。
const refreshed = page.waitForResponse((response) =>
  response.url().includes("/api/v1/state"),
);
await page.getByRole("button", { name: "刷新" }).click();
assert.equal((await refreshed).status(), 200);
const refreshedToast = page.getByRole("status").filter({ hasText: "已刷新" });
await refreshedToast.waitFor();
await refreshedToast.waitFor({ state: "detached", timeout: 3000 });
assert.ok(page.url().endsWith("/child"));

// 静默轮询（src/store.ts 的 autoRefreshMs）：两端共用一块屏，孩子交完就走开，
// 家长那一屏得自己动。这里不点任何按钮，只把页面时钟拨快 90 秒，看它自己有没有
// 再去拿一次 /state（时钟在页面加载前装好，不先把启动阶段的 setTimeout 冻住不行）。
const pollPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
collectErrors(pollPage);
await pollPage.clock.install();
await pollPage.goto(`${baseUrl}/child`, { waitUntil: "load" });
await pollPage.locator(".bottom-nav").waitFor();
assert.equal(
  await pollPage.evaluate(() => document.visibilityState),
  "visible",
  "headless 页面不可见的话这一段的断言就没有意义了",
);
// 启动自己的那一次 /state 先走完，再把时钟拨过一轮轮询区间。
await pollPage.waitForTimeout(400);
const autoPolled = pollPage.waitForResponse((response) =>
  response.url().includes("/api/v1/state"),
);
await pollPage.clock.fastForward("01:30");
assert.equal((await autoPolled).status(), 200);
await pollPage.close();

// 全部确认：家长一次点完所有待确认。它逐条 POST 同一条 review 路由（每条自己的
// Idempotency-Key），所以服务端「恰好一次」的保证和手动确认一模一样。任务用接口造、
// 用接口提交，只为了把屏幕上那个按钮和角标验到；这个页面自己一套 cookie，
// 不会动到主页那一屏的会话。
const batchPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
collectErrors(batchPage);
const batchApi = (path, init) =>
  batchPage.evaluate(async ([path, init]) => {
    const response = await fetch(`/api/v1${path}`, init);
    return [response.status, await response.text()];
  }, [path, init]);
const jsonBody = (value) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
await batchPage.goto(`${baseUrl}/child`, { waitUntil: "load" });
await batchPage.locator(".bottom-nav").waitFor();
let [batchStatus] = await batchApi(
  "/auth/parent",
  jsonBody({ password: "1357" }),
);
assert.equal(batchStatus, 200, "批量确认段没能进入家长端");
const batchState = JSON.parse((await batchApi("/state", {}))[1]);
const batchTitles = ["批量确认甲", "批量确认乙"];
for (const title of batchTitles) {
  [batchStatus] = await batchApi(
    "/tasks/",
    jsonBody({
      childId: batchState.activeChildId,
      title,
      description: "一次点完",
      category: "生活自理",
      points: 10,
      repeatRule: "daily",
      repeatWeekday: 0,
    }),
  );
  assert.equal(batchStatus, 200, `创建 ${title} 失败`);
}
[batchStatus] = await batchApi("/auth/child", { method: "POST" });
assert.equal(batchStatus, 200);
// 一键提交就是 multipart 空 body + Idempotency-Key，和孩子端点一下一模一样。
const submitStatuses = await batchPage.evaluate(async (titles) => {
  const state = await (await fetch("/api/v1/state")).json();
  const statuses = [];
  for (const title of titles) {
    const task = state.tasks
      .filter((item) => item.title === title)
      .sort((left, right) => right.dueDate.localeCompare(left.dueDate))[0];
    const form = new FormData();
    form.append("note", "");
    const response = await fetch(`/api/v1/tasks/${task.id}/submit`, {
      method: "POST",
      body: form,
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    statuses.push(response.status);
  }
  return statuses;
}, batchTitles);
assert.deepEqual(submitStatuses, [200, 200]);
await batchPage.goto(`${baseUrl}/parent`, { waitUntil: "load" });
// 页面加载会重新开孩子端（家长会话是一次性升级），所以这里要重新输密码。
const batchPin = batchPage.locator(".pin-modal");
await batchPin.waitFor();
await batchPin.getByLabel("家长密码").fill("1357");
await batchPin.getByRole("button", { name: "验证并进入" }).click();
await batchPage.waitForURL(/\/parent$/);
const pendingBefore = await batchPage.evaluate(async () => {
  const state = await (await fetch("/api/v1/state")).json();
  return state.tasks.filter(
    (task) =>
      task.status === "pending_review" && task.childId === state.activeChildId,
  ).length;
});
assert.ok(pendingBefore >= 2, `待确认只有 ${pendingBefore} 条，造数据没生效`);
assert.equal(
  Number(await batchPage.locator(".nav-badge").first().innerText()),
  pendingBefore,
  "侧边栏角标和 /state 里的待确认条数不一致",
);
await batchPage.getByRole("button", { name: "全部确认" }).click();
await batchPage.getByRole("button", { name: "确认全部" }).click();
await batchPage
  .getByRole("status")
  .filter({ hasText: `已确认 ${pendingBefore} 项` })
  .waitFor();
const batchDone = JSON.parse((await batchApi("/state", {}))[1]);
for (const title of batchTitles) {
  assert.equal(
    batchDone.tasks.filter((task) => task.title === title).every((task) => task.status === "completed"),
    true,
    `${title} 没被全部确认`,
  );
}
await batchPage.locator(".nav-badge").first().waitFor({ state: "detached" });
await batchPage.close();

// ── 游戏扣分：家长设两个价，孩子开新局/点提示各扣一次，续玩免费，积分不够就开不了。
const wallet = (state) =>
  state.children.find((child) => child.id === state.activeChildId).pointsBalance;
await enterParent(false, "1357");
await page.getByRole("link", { name: "游戏进度" }).click();
await page.waitForURL(/\/parent\/games$/);
// 默认 0 = 免费，存量家庭升级后不会被莫名扣分，所以这里先确认起点是 0。
assert.equal(await page.getByLabel("每次游玩扣积分").inputValue(), "0");
assert.equal(await page.getByLabel("每次提示扣积分").inputValue(), "0");
await page.getByLabel("每次游玩扣积分").fill("5");
await page.getByLabel("每次提示扣积分").fill("2");
const costsSaved = page.waitForResponse(
  (response) =>
    response.request().method() === "PUT" &&
    response.url().endsWith("/api/v1/games/costs"),
);
await page.getByRole("button", { name: "保存扣分设置" }).click();
assert.equal((await costsSaved).status(), 200, "保存扣分设置没有成功");
await page.getByRole("status").filter({ hasText: "扣分设置已保存" }).waitFor();
await waitForState((state) => state.gameCosts.playCost === 5 && state.gameCosts.hintCost === 2);

// 第 3 关还没通关（提示按钮可用），也没有断点存档，所以进棋盘前先停在收费门口。
await enterChild();
const costBalance = wallet(await getState());
await page.goto(`${baseUrl}/child/games/klotski?level=3`);
await settleRewards();
await page.locator(".klotski-start").waitFor();
assert.ok(
  (await page.locator(".klotski-start").innerText()).includes("本关开始扣 5 积分"),
  "收费局的门口没写清楚要扣多少",
);
const paidPlay = page.waitForResponse((response) =>
  response.url().endsWith("/api/v1/games/play"),
);
await page.getByRole("button", { name: /开始本关/ }).click();
assert.equal((await paidPlay).status(), 200, "开始本关没有扣款成功");
await page.locator(".klotski-piece").first().waitFor();
await page.getByRole("status").filter({ hasText: "已扣 5 积分" }).waitFor();
await waitForState((state) => wallet(state) === costBalance - 5);
const paidHint = page.waitForResponse((response) =>
  response.url().endsWith("/api/v1/games/hint"),
);
await page.getByRole("button", { name: "提示（−2 积分）" }).click();
assert.equal((await paidHint).status(), 200, "提示没有扣款成功");
await page.locator(".klotski-hint").waitFor();
const charged = await waitForState((state) => wallet(state) === costBalance - 7);
// 两笔都落在孩子自己的积分明细里（家长端「消费积分」也读同一批 spent 行）。
assert.deepEqual(
  charged.ledger
    .filter((row) => row.childId === charged.activeChildId && row.referenceId.startsWith("klotski:3:"))
    .map((row) => `${row.amount} ${row.description}`)
    .sort(),
  ["-2 华容道第3关：使用提示", "-5 华容道第3关：开始一局"],
);

// 把余额扣到 0：手动调分单次上限 500，所以按余额循环扣 min(余额, 500)。
await enterParent(false, "1357");
for (let guard = 0; guard < 20; guard += 1) {
  const remaining = wallet(await getState());
  if (remaining <= 0) break;
  await page.getByRole("button", { name: "奖励积分" }).click();
  const pointsModal = page.locator(".form-modal");
  await pointsModal.waitFor();
  await pointsModal.getByRole("button", { name: "扣除积分" }).click();
  await pointsModal.getByLabel("积分数量").fill(String(Math.min(remaining, 500)));
  const deducted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/v1\/children\/[^/]+\/points$/.test(response.url()),
  );
  await pointsModal.getByRole("button", { name: "确认扣除" }).click();
  assert.equal((await deducted).status(), 200, "扣除积分失败");
  await page.locator(".form-modal").waitFor({ state: "detached" });
}
assert.equal(wallet(await getState()), 0, "余额没有扣到 0");

// 0 分就不能开新局：按钮置灰 + 写明还差多少，后端另有 409 兜底。
await enterChild();
await page.goto(`${baseUrl}/child/games/calc`);
await settleRewards();
await page.locator(".quiz-levels").waitFor();
assert.equal(
  await page.getByRole("button", { name: /第1档/ }).isDisabled(),
  true,
  "积分不足时还能开新局",
);
await page.getByText("积分不足，还差 5 分").waitFor();

// 改回免费：不弹确认，点一下就开局。
await enterParent(false, "1357");
await page.getByRole("link", { name: "游戏进度" }).click();
await page.waitForURL(/\/parent\/games$/);
await page.getByLabel("每次游玩扣积分").fill("0");
await page.getByLabel("每次提示扣积分").fill("0");
const costsReset = page.waitForResponse(
  (response) =>
    response.request().method() === "PUT" &&
    response.url().endsWith("/api/v1/games/costs"),
);
await page.getByRole("button", { name: "保存扣分设置" }).click();
assert.equal((await costsReset).status(), 200, "改回免费没保存成功");
await waitForState((state) => state.gameCosts.playCost === 0 && state.gameCosts.hintCost === 0);
await enterChild();
await page.goto(`${baseUrl}/child/games/calc`);
await settleRewards();
await page.getByRole("button", { name: /第1档/ }).click();
await page.locator(".quiz-problem").waitFor();
assert.equal(await page.locator(".modal").count(), 0, "免费局不该再弹确认");


assert.deepEqual(errors, []);
console.log(
  JSON.stringify({
    submittedWithoutCredit: true,
    approvedBalance: initialBalance + 20,
    rewardFeedback: true,
    rewardPerTask: true,
    pointsAward: true,
    pointsDeduct: true,
    parentPasswordChange: true,
    redeemedBalance: initialBalance - 60,
    persistedAfterReload: true,
    rejectedAndResubmitted: true,
    childProfileSwitch: true,
    parentPasswordGate: true,
    submissionEvidence: true,
    childMediaVisible: true,
    parentMediaVisible: true,
    mediaViewer: true,
    taskWishManagement: true,
    wishToggle: true,
    childProfileCrud: true,
    redemptionCompleted: true,
    redemptionCompletionPersisted: true,
    redemptionCompletionParentReadOnly: true,
    redemptionCompletionReversible: true,
    redemptionCompletionEvidence: true,
    growthDayStats: true,
    growthCalendarLunar: true,
    growthBackfill: true,
    statsRange: true,
    homework: true,
    homeworkOnHome: true,
    homeworkViewer: true,
    homeworkDateNav: true,
    homeworkFont: true,
    homeworkHolidayRange: true,
    refreshButton: true,
    reviewReason: true,
    autoRefresh: true,
    batchReview: true,
    wishProgress: true,
    ledgerPage: true,
    levelUpToast: true,
    ledgerSpend: true,
    klotskiUnlock: true,
    klotskiSolve: true,
    klotskiGuard: true,
    klotskiParentProgress: true,
    gameCosts: true,
    gameCostCharged: true,
    gameCostInsufficient: true,
    rewardSeenCursor: true,
    consoleErrors: errors.length,
  }),
);
await browser.close();
