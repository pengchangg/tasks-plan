import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("console", (message) => {
  if (
    message.type() === "error" &&
    !message.text().includes("401 (Unauthorized)")
  )
    errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

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
async function waitForState(predicate) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await getState();
    if (state && predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out waiting for server state");
}
async function unlockParent(checkError = false, url = /\/parent$/) {
  const modal = page.locator(".pin-modal");
  await modal.waitFor();
  const input = modal.getByLabel("家长密码");
  if (checkError) {
    await input.fill("wrong-password");
    await modal.getByRole("button", { name: "验证并进入" }).click();
    await modal.getByText("密码不正确，请重新输入").waitFor();
  }
  await input.fill("growjoy2468");
  await modal.getByRole("button", { name: "验证并进入" }).click();
  await page.waitForURL(url);
}
async function enterParent(checkError = false) {
  await page.locator(".profile-button").click();
  await page
    .locator(".role-menu")
    .getByRole("button", { name: /家长端/ })
    .click();
  await unlockParent(checkError);
}

await page.goto(`${baseUrl}/child/tasks`, { waitUntil: "networkidle" });
await openChildEnd();
await page.getByText("整理自己的书桌").waitFor();
let state = await getState();
const initialBalance = state.children.find(
  (c) => c.name === "米娅",
).pointsBalance;
const deskId = state.tasks.find((t) => t.title === "整理自己的书桌").id;
const task = page.locator(".task-card").filter({ hasText: "整理自己的书桌" });
await task.getByRole("button", { name: "完成任务" }).click();
await task
  .getByPlaceholder("写一句话告诉家长吧（可选）")
  .fill("书本都放整齐了");
await task.locator('input[accept="image/*"]').setInputFiles({
  name: "desk-proof.jpg",
  mimeType: "image/jpeg",
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]),
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
await page.goto(`${baseUrl}/parent/tasks`, { waitUntil: "networkidle" });
await page.waitForURL(/\/child$/);
await unlockParent(true, /\/parent\/tasks$/);
await page.getByRole("link", { name: "任务管理" }).click();
const parentTask = page
  .locator(".admin-task-item")
  .filter({ hasText: "整理自己的书桌" });
await parentTask.getByText("书本都放整齐了").waitFor();
await parentTask.getByText("desk-proof.jpg").waitFor();
await parentTask.getByText("desk-proof.mp4").waitFor();
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

await page.locator(".profile-button").click();
await page
  .locator(".role-menu")
  .getByRole("button", { name: /孩子端/ })
  .click();
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

await enterParent();
await page.getByRole("link", { name: "任务管理" }).click();
const readingTask = page
  .locator(".admin-row")
  .filter({ hasText: "阅读 20 分钟" });
await readingTask.getByRole("button", { name: "退回" }).click();
await waitForState(
  (s) => s.tasks.find((t) => t.title === "阅读 20 分钟")?.status === "rejected",
);
await page.locator(".profile-button").click();
await page
  .locator(".role-menu")
  .getByRole("button", { name: /孩子端/ })
  .click();
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

await switchChild("乐乐");
await page.getByText("收拾玩具箱").waitFor();
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
await page.getByRole("button", { name: "删除安安" }).click();
await page.getByRole("button", { name: "确认删除" }).click();
await waitForState((s) => !s.children.some((c) => c.name === "安安"));
assert.deepEqual(errors, []);
console.log(
  JSON.stringify({
    submittedWithoutCredit: true,
    approvedBalance: initialBalance + 20,
    rewardFeedback: true,
    redeemedBalance: initialBalance - 60,
    persistedAfterReload: true,
    rejectedAndResubmitted: true,
    childProfileSwitch: true,
    parentPasswordGate: true,
    submissionEvidence: true,
    taskWishManagement: true,
    childProfileCrud: true,
    consoleErrors: errors.length,
  }),
);
await browser.close();
