import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4173";
await mkdir(".artifacts/ui", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
function collectErrors(target) {
  target.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("401 (Unauthorized)")
    )
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
    await input.fill(rejected);
    await modal.getByRole("button", { name: "验证并进入" }).click();
    await modal.getByText("密码不正确，请重新输入").waitFor();
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
  await waitForState((s) => s.role === "child");
}

await page.goto(`${baseUrl}/child/tasks`, { waitUntil: "networkidle" });
await openChildEnd();
await page.getByText("整理自己的书桌").waitFor();
let state = await getState();
assert.equal(state.children.length, 1);
const initialBalance = state.children.find(
  (c) => c.name === "米娅",
).pointsBalance;
const deskId = state.tasks.find((t) => t.title === "整理自己的书桌").id;
const task = page.locator(".task-card").filter({ hasText: "整理自己的书桌" });
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
await task
  .getByPlaceholder("写一句话告诉家长吧（可选）")
  .fill("书本都放整齐了");
await task.locator('input[accept="image/*"]').setInputFiles({
  name: "desk-proof.png",
  mimeType: "image/png",
  buffer: proofPng,
});
await task.locator('input[accept="video/*"]').setInputFiles({
  name: "desk-proof.mp4",
  mimeType: "video/mp4",
  buffer: Buffer.from(
    "00000018667479706d703432000000006d70343269736f6d",
    "hex",
  ),
});
await task.getByRole("button", { name: "提交给家长确认" }).click();
state = await waitForState(
  (s) => s.tasks.find((t) => t.id === deskId)?.status === "pending_review",
);
assert.equal(
  state.children.find((c) => c.name === "米娅").pointsBalance,
  initialBalance,
);
const childEvidence = task.locator(".media-thumb img");
await assertRealImage(childEvidence, proofSize);
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
await parentTask.getByText("书本都放整齐了").waitFor();
await parentTask.getByAltText("desk-proof.png").waitFor();
await parentTask.locator(".media-video").waitFor();
assert.equal(await parentTask.locator(".media-thumb, .media-video").count(), 2);
const evidenceImage = parentTask.locator(".media-thumb img");
await assertRealImage(evidenceImage, proofSize);
await parentTask.locator(".media-thumb").click();
await page.locator(".media-viewer img").waitFor();
await page.screenshot({
  path: ".artifacts/ui/evidence-parent.png",
  fullPage: true,
});
await page.locator(".modal-backdrop .modal-close").click();
await page.locator(".media-viewer").waitFor({ state: "detached" });
const video = parentTask.locator(".media-video");
assert.ok(await video.evaluate((node) => node.controls));
assert.deepEqual(
  await page.evaluate(async () => {
    const response = await fetch(document.querySelector(".media-video").src);
    return [response.status, response.headers.get("content-type")];
  }),
  [200, "video/mp4"],
);
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
await starRow.getByRole("button", { name: "确认完成" }).click();
state = await waitForState((s) => Boolean(s.redemptions.at(-1)?.completedAt));
assert.equal(state.redemptions.at(-1).completedNote, wishNote);
assert.equal(state.redemptions.at(-1).attachments.length, 1);
await page.reload({ waitUntil: "networkidle" });
await starRow.getByText("已完成").waitFor();
await starRow.getByText(wishNote).waitFor();
await assertRealImage(starRow.locator(".media-thumb img"), proofSize);
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
assert.equal(await parentStarRow.getByRole("button", { name: "标记完成" }).count(), 0);
assert.equal(await parentStarRow.getByRole("button", { name: "撤销完成" }).count(), 0);
await page.getByRole("link", { name: "任务管理" }).click();
const readingTask = page
  .locator(".admin-row")
  .filter({ hasText: "阅读 20 分钟" });
await readingTask.getByRole("button", { name: "退回" }).click();
await waitForState(
  (s) => s.tasks.find((t) => t.title === "阅读 20 分钟")?.status === "rejected",
);
await enterChild();
await page.getByRole("link", { name: "愿望", exact: true }).click();
const reopenRow = page.locator(".star-row").filter({ hasText: "选择一次晚餐" });
await reopenRow.getByRole("button", { name: "撤销完成" }).click();
await page.getByRole("button", { name: "确认撤销" }).click();
await waitForState((s) => !s.redemptions.at(-1)?.completedAt);
await reopenRow.getByText("未完成").waitFor();
assert.equal(await reopenRow.locator(".media-thumb").count(), 0);
assert.ok(!(await reopenRow.innerText()).includes(wishNote));
await page.getByRole("link", { name: "任务", exact: true }).click();
const rejectedTask = page
  .locator(".task-card")
  .filter({ hasText: "阅读 20 分钟" });
await rejectedTask.getByRole("button", { name: "重新提交" }).click();
await rejectedTask.getByRole("button", { name: "提交给家长确认" }).click();
await waitForState(
  (s) =>
    s.submissions.filter(
      (item) =>
        item.taskId === s.tasks.find((t) => t.title === "阅读 20 分钟")?.id,
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
await page
  .getByLabel("每周星期")
  .selectOption(String((familyToday.weekday + 3) % 7));
await page.getByRole("button", { name: "发布任务" }).click();
state = await waitForState((s) =>
  s.tasks.some((t) => t.title === "每周整理书架"),
);
const weeklyTask = state.tasks.find((t) => t.title === "每周整理书架");
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
await page.screenshot({
  path: ".artifacts/ui/growth-day.png",
  fullPage: true,
});

await page.getByRole("link", { name: "任务", exact: true }).click();
const weeklyCard = page
  .locator(".task-card")
  .filter({ hasText: "每周整理书架" });
await weeklyCard.getByRole("button", { name: "完成任务" }).click();
await weeklyCard.getByRole("button", { name: "提交给家长确认" }).click();
await waitForState(
  (s) =>
    s.tasks.find((t) => t.title === "每周整理书架")?.status === "pending_review",
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
  (s) => s.tasks.find((t) => t.title === "阅读 20 分钟")?.status === "completed",
);
const readingPoints = approved.tasks.find(
  (t) => t.title === "阅读 20 分钟",
).points;
// created_at 是去掉尾零的 RFC3339Nano，同一秒内的两条记录不能保证字典序等于
// 时间序；这里让两次确认跨秒，排队顺序才是确定的。
await page.waitForTimeout(1100);
const weeklyRow = page
  .locator(".admin-task-item")
  .filter({ hasText: "每周整理书架" })
  .first();
await weeklyRow.getByRole("button", { name: "确认", exact: true }).click();
approved = await waitForState(
  (s) => s.tasks.find((t) => t.title === "每周整理书架")?.status === "completed",
);
const weeklyPoints = approved.tasks.find(
  (t) => t.title === "每周整理书架",
).points;

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
await passwordModal.getByRole("button", { name: "保存新密码" }).click();
await passwordModal.getByText("当前密码不正确，请重新输入").waitFor();
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
await page.getByLabel("任务名称").fill("倒垃圾");
await page.getByLabel("重复方式").selectOption("daily");
await page.getByRole("button", { name: "发布任务" }).click();
state = await waitForState((s) => s.tasks.some((t) => t.title === "倒垃圾"));
assert.equal(
  state.tasks.find((t) => t.title === "倒垃圾").childId,
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
await degradedCard.getByRole("button", { name: "完成任务" }).click();
const degradedSubmit = degraded.waitForResponse((response) =>
  response.url().includes("/submit"),
);
await degradedCard.getByRole("button", { name: "提交给家长确认" }).click();
const submitted = await degradedSubmit;
assert.equal(submitted.status(), 200);
assert.match(
  submitted.request().headers()["idempotency-key"],
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
await degraded.close();

assert.deepEqual(errors, []);
console.log(
  JSON.stringify({
    submittedWithoutCredit: true,
    approvedBalance: initialBalance + 20,
    rewardFeedback: true,
    rewardPerTask: true,
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
    childProfileCrud: true,
    redemptionCompleted: true,
    redemptionCompletionPersisted: true,
    redemptionCompletionParentReadOnly: true,
    redemptionCompletionReversible: true,
    redemptionCompletionEvidence: true,
    growthDayStats: true,
    growthBackfill: true,
    consoleErrors: errors.length,
  }),
);
await browser.close();
