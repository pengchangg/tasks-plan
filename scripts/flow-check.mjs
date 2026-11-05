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
state = await getState();
assert.equal(
  state.children.find((c) => c.name === "米娅").pointsBalance,
  initialBalance - 60,
);
assert.equal(state.redemptions.at(-1).wishId, dinner.id);
const starRow = page.locator(".star-row").filter({ hasText: "选择一次晚餐" });
const wishNote = "晚餐点了披萨，全家一起吃光啦";
await starRow.getByRole("button", { name: "标记完成" }).click();
await starRow.getByPlaceholder("写一句话记录这一刻吧（可选）").fill(wishNote);
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
// 这一条故意关掉「完成需要我确认」：孩子勾完当场给分，下面那一大段 +N 徽章与取消
// 回冲的旧链路才能接着验（默认是要确认的，确认链路另起一段）。
await homeworkModal.getByLabel("完成需要我确认").uncheck();
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

// 作业确认（默认）：孩子勾上只进「待确认」——余额不动、卡上标「待家长确认」，
// 家长在总览点确认才真的结算。这条作业保留表单默认的勾选，所以走的是确认链路。
await enterParent(false, "1357");
await page.getByRole("link", { name: "作业管理" }).click();
await page.waitForURL(/\/parent\/homework$/);
await page.getByRole("button", { name: "新增作业" }).click();
const confirmModal = page.locator(".form-modal");
await confirmModal.waitFor();
await confirmModal.getByRole("button", { name: "数学" }).click();
await confirmModal.getByLabel("文字描述").fill("完成练习册第 12 页。");
assert.equal(
  await confirmModal.getByLabel("完成需要我确认").isChecked(),
  true,
  "新增作业默认就要家长确认",
);
await confirmModal.getByRole("button", { name: "保存作业" }).click();
await page.getByText("作业已保存").waitFor();

await enterChild();
await page.getByRole("link", { name: "作业" }).click();
await page.waitForURL(/\/child\/homework$/);
const pendingCard = page
  .locator(".homework-card")
  .filter({ hasText: "完成练习册第 12 页" });
await pendingCard.waitFor();
const balanceBeforeConfirm = await pointsBalance();
await pendingCard.locator(".homework-check input").check();
await pendingCard.locator(".homework-pending").waitFor();
assert.equal(
  await pendingCard.locator(".homework-award").count(),
  0,
  "没确认就发分，那张卡不该标 +N",
);
assert.equal(await pointsBalance(), balanceBeforeConfirm, "没确认就不该给分");

await enterParent(false, "1357");
const pendingRow = page.locator(".pending-row").filter({ hasText: "数学" });
await pendingRow.waitFor();
assert.ok(
  (await page.locator(".parent-section-head").filter({ hasText: "作业待确认" }).innerText()).includes(
    "作业待确认",
  ),
);
await pendingRow.getByRole("button", { name: "确认" }).click();
await page.getByText("作业已确认").waitFor();
await page.locator(".pending-list").waitFor({ state: "detached" });
// 今天只有这一科，所以确认后是「5 分 + 全天完成奖 5 分」还是只有 5 分，取决于假期
// 那条作业今天是否也在名单里（两者都是服务端的真账），这里只钉住它是 5 的倍数且大于 0。
const confirmedDelta = (await pointsBalance()) - balanceBeforeConfirm;
assert.ok(
  confirmedDelta >= 5 && confirmedDelta % 5 === 0,
  `确认后应结算 5 或 10 分，实得 ${confirmedDelta}`,
);

await enterChild();
await page.getByRole("link", { name: "作业" }).click();
await page.waitForURL(/\/child\/homework$/);
await pendingCard.waitFor();
assert.equal(
  await pendingCard.locator(".homework-pending").count(),
  0,
  "确认之后孩子那一屏不该再标待家长确认",
);
assert.equal(
  await pendingCard.locator(".homework-check input").isChecked(),
  true,
  "确认后孩子那一屏仍是已完成",
);

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
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
await batchPage.goto(`${baseUrl}/child`, { waitUntil: "load" });
await batchPage.locator(".bottom-nav").waitFor();
let [batchStatus] = await batchApi(
  "/auth/parent",
  jsonBody({ password: "2468" }),
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
await batchPin.getByLabel("家长密码").fill("2468");
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
    homeworkPendingConfirm: true,
    refreshButton: true,
    reviewReason: true,
    autoRefresh: true,
    batchReview: true,
    consoleErrors: errors.length,
  }),
);
await browser.close();
