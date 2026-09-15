import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

async function getState() {
  const raw = await page.evaluate(() =>
    localStorage.getItem("growjoy-state-v1"),
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function waitForState(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await getState();
    if (state && predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out waiting for persisted state");
}

let pinErrorChecked = false;
async function unlockParent() {
  const modal = page.locator(".pin-modal");
  await modal.waitFor();
  const input = modal.getByLabel("4 位数字密码");
  if (!pinErrorChecked) {
    await input.fill("0000");
    await modal.getByRole("button", { name: "验证并进入" }).click();
    await modal.getByText("密码不正确，请重新输入").waitFor();
    pinErrorChecked = true;
  }
  await input.fill("2468");
  await modal.getByRole("button", { name: "验证并进入" }).click();
  await page.waitForURL(/\/parent$/);
}

async function enterParent() {
  await page.locator(".profile-button").click();
  await page
    .locator(".role-menu")
    .getByRole("button", { name: /家长端/ })
    .click();
  await unlockParent();
}

await page.goto(`${baseUrl}/child/tasks`, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });

const task = page.locator(".task-card").filter({ hasText: "整理自己的书桌" });
await task.getByRole("button", { name: "完成任务" }).click();
await task
  .getByPlaceholder("写一句话告诉家长吧（可选）")
  .fill("书本都放整齐了");
await task.locator('input[accept="image/*"]').setInputFiles({
  name: "desk-proof.jpg",
  mimeType: "image/jpeg",
  buffer: Buffer.from("image-proof"),
});
await task.locator('input[accept="video/*"]').setInputFiles({
  name: "desk-proof.mp4",
  mimeType: "video/mp4",
  buffer: Buffer.from("video-proof"),
});
await task.getByRole("button", { name: "提交给家长确认" }).click();
await waitForState(
  (state) =>
    state.tasks.find((item) => item.id === "t1").status === "pending_review",
);
let state = await getState();
assert.equal(
  state.children[0].pointsBalance,
  185,
  "submitting must not credit points",
);

await page.goto(`${baseUrl}/parent/tasks`, { waitUntil: "networkidle" });
await page.waitForURL(/\/child$/);
await unlockParent();
await page.getByRole("link", { name: "任务管理" }).click();
const parentTask = page
  .locator(".admin-task-item")
  .filter({ hasText: "整理自己的书桌" });
await parentTask.getByText("书本都放整齐了").waitFor();
await parentTask.getByText("desk-proof.jpg").waitFor();
await parentTask.getByText("desk-proof.mp4").waitFor();
await parentTask.getByRole("button", { name: "确认", exact: true }).click();
await waitForState((state) => state.children[0].pointsBalance === 205);
await parentTask.getByRole("button", { name: "编辑整理自己的书桌" }).click();
await page.getByLabel("任务名称").fill("整理书桌与书架");
await page.getByRole("button", { name: "保存修改" }).click();
await waitForState(
  (state) =>
    state.tasks.find((item) => item.id === "t1").title === "整理书桌与书架",
);

await page.getByRole("link", { name: "愿望管理" }).click();
const managedWish = page
  .locator(".admin-wish")
  .filter({ hasText: "公园探险半日游" });
await managedWish.getByRole("button", { name: "编辑公园探险半日游" }).click();
await page.getByLabel("愿望名称").fill("周末公园探险");
await page.getByRole("button", { name: "保存修改" }).click();
await waitForState(
  (state) =>
    state.wishes.find((item) => item.id === "w3").title === "周末公园探险",
);
await page.getByRole("button", { name: "删除周末公园探险" }).click();
await page.getByRole("button", { name: "确认删除" }).click();
await waitForState((state) => !state.wishes.some((item) => item.id === "w3"));

await page.locator(".profile-button").click();
await page
  .locator(".role-menu")
  .getByRole("button", { name: /孩子端/ })
  .click();
await page.getByText("+20 积分到账！").waitFor();

await page.getByRole("link", { name: "愿望", exact: true }).click();
const wish = page.locator(".wish-card").filter({ hasText: "选择一次晚餐" });
await wish.getByRole("button", { name: "去兑换" }).click();
await page.getByRole("button", { name: "确认兑换" }).click();
await waitForState((state) => state.children[0].pointsBalance === 125);
await page.reload({ waitUntil: "networkidle" });
state = await getState();
assert.equal(
  state.children[0].pointsBalance,
  125,
  "balance must persist after reload",
);
assert.equal(state.redemptions.at(-1).wishId, "w2");

await enterParent();
await page.getByRole("link", { name: "任务管理" }).click();
const readingTask = page
  .locator(".admin-row")
  .filter({ hasText: "阅读 20 分钟" });
await readingTask.getByRole("button", { name: "退回" }).click();
await waitForState(
  (state) => state.tasks.find((item) => item.id === "t2").status === "rejected",
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
  (state) =>
    state.submissions.filter((item) => item.taskId === "t2").length === 2,
);
state = await getState();
assert.equal(
  state.tasks.find((item) => item.id === "t2").status,
  "pending_review",
);

await page.locator(".profile-button").click();
await page.locator(".role-menu").getByRole("button", { name: /乐乐/ }).click();
await waitForState((state) => state.activeChildId === "leo");
await page.getByText("收拾玩具箱").waitFor();

await enterParent();
await page.getByRole("link", { name: "孩子管理" }).click();
await page.getByRole("button", { name: "新增孩子" }).click();
await page.getByLabel("孩子姓名").fill("小安");
await page.getByRole("button", { name: "添加孩子" }).click();
await waitForState(
  (state) =>
    state.children.length === 3 &&
    state.children.some((child) => child.name === "小安"),
);
await page.getByRole("button", { name: "编辑小安" }).click();
await page.getByLabel("孩子姓名").fill("安安");
await page.getByRole("button", { name: "保存修改" }).click();
await waitForState((state) =>
  state.children.some((child) => child.name === "安安"),
);
await page.getByRole("button", { name: "删除安安" }).click();
await page.getByRole("button", { name: "确认删除" }).click();
await waitForState(
  (state) =>
    state.children.length === 2 &&
    !state.children.some((child) => child.name === "安安"),
);
assert.deepEqual(errors, [], "browser console must stay clean");

console.log(
  JSON.stringify({
    submittedWithoutCredit: true,
    approvedBalance: 205,
    rewardFeedback: true,
    redeemedBalance: 125,
    persistedAfterReload: true,
    rejectedAndResubmitted: true,
    childProfileSwitch: true,
    parentPinGate: true,
    submissionEvidence: true,
    taskWishManagement: true,
    childProfileCrud: true,
    consoleErrors: errors.length,
  }),
);

await browser.close();
