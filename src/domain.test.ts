import { describe, expect, it } from "vitest";
import { seedState } from "./data";
import {
  deleteChild,
  deleteTask,
  deleteWish,
  redeemWish,
  reviewTask,
  saveChild,
  saveTask,
  saveWish,
  submitTask,
  type DomainClock,
} from "./domain";
import type { AppState } from "./types";

function freshState(): AppState {
  return structuredClone(seedState);
}

function fixedClock(): DomainClock {
  let sequence = 0;
  return {
    id: (prefix) => `${prefix}-${(sequence += 1)}`,
    now: () => "2025-01-02T03:04:05.000Z",
  };
}

describe("task lifecycle", () => {
  it("submits evidence without crediting points", () => {
    const state = freshState();
    const balance = state.children[0].pointsBalance;

    const next = submitTask(
      state,
      "t1",
      "已经整理好了",
      [{ name: "desk.jpg", type: "image" }],
      fixedClock(),
    );

    expect(next.tasks.find((task) => task.id === "t1")?.status).toBe(
      "pending_review",
    );
    expect(next.children[0].pointsBalance).toBe(balance);
    expect(next.submissions[next.submissions.length - 1]).toMatchObject({
      taskId: "t1",
      note: "已经整理好了",
    });
  });

  it("credits an approved task exactly once", () => {
    const state = freshState();
    const balance = state.children[0].pointsBalance;
    const ledgerCount = state.ledger.length;

    const approved = reviewTask(state, "t2", true, "完成得很好", fixedClock());
    const approvedAgain = reviewTask(approved, "t2", true, "", fixedClock());

    expect(approved.children[0].pointsBalance).toBe(balance + 30);
    expect(approved.ledger).toHaveLength(ledgerCount + 1);
    expect(approvedAgain).toBe(approved);
    expect(approvedAgain.children[0].pointsBalance).toBe(balance + 30);
  });

  it("allows a rejected task to be submitted again", () => {
    const state = freshState();
    const rejected = reviewTask(
      state,
      "t2",
      false,
      "请补一张照片",
      fixedClock(),
    );
    const resubmitted = submitTask(
      rejected,
      "t2",
      "补上照片啦",
      [{ name: "reading.jpg", type: "image" }],
      fixedClock(),
    );

    expect(rejected.tasks.find((task) => task.id === "t2")?.status).toBe(
      "rejected",
    );
    expect(resubmitted.tasks.find((task) => task.id === "t2")?.status).toBe(
      "pending_review",
    );
    expect(
      resubmitted.submissions.filter((item) => item.taskId === "t2"),
    ).toHaveLength(2);
  });
});

describe("child profile management", () => {
  it("creates a zero-balance child and makes it active", () => {
    const state = freshState();
    const next = saveChild(
      state,
      { name: " 小安 ", avatar: "🌈", color: "#67a9dc" },
      undefined,
      fixedClock(),
    );

    expect(next.children).toHaveLength(state.children.length + 1);
    expect(next.children[next.children.length - 1]).toMatchObject({
      id: "child-1",
      name: "小安",
      pointsBalance: 0,
      level: 1,
    });
    expect(next.activeChildId).toBe("child-1");
  });

  it("edits profile fields without changing progress", () => {
    const state = freshState();
    const next = saveChild(
      state,
      { name: "米娅新名字", avatar: "⭐", color: "#7bc47f" },
      "mia",
    );
    const child = next.children.find((item) => item.id === "mia")!;

    expect(child).toMatchObject({
      name: "米娅新名字",
      avatar: "⭐",
      pointsBalance: 185,
      level: 4,
    });
  });

  it("cascades owned data on deletion and preserves the last child", () => {
    const state = freshState();
    const deleted = deleteChild(state, "mia");

    expect(deleted.activeChildId).toBe("leo");
    expect(deleted.tasks.every((item) => item.childId !== "mia")).toBe(true);
    expect(deleted.submissions.every((item) => item.childId !== "mia")).toBe(
      true,
    );
    expect(deleted.ledger.every((item) => item.childId !== "mia")).toBe(true);
    expect(deleted.redemptions.every((item) => item.childId !== "mia")).toBe(
      true,
    );
    expect(deleteChild(deleted, "leo")).toBe(deleted);
  });
});

describe("task and wish management", () => {
  it("edits a task without resetting its review state or submission", () => {
    const state = freshState();
    const next = saveTask(
      state,
      {
        childId: "mia",
        title: "阅读半小时",
        description: "读完后说说最喜欢的一段",
        category: "学习成长",
        points: 40,
        repeatRule: "weekly",
      },
      "t2",
    );

    expect(next.tasks.find((task) => task.id === "t2")).toMatchObject({
      title: "阅读半小时",
      points: 40,
      status: "pending_review",
    });
    expect(next.submissions).toEqual(state.submissions);
  });

  it("deletes a task and its submissions while preserving point history", () => {
    const state = freshState();
    const next = deleteTask(state, "t2");

    expect(next.tasks.some((task) => task.id === "t2")).toBe(false);
    expect(
      next.submissions.some((submission) => submission.taskId === "t2"),
    ).toBe(false);
    expect(next.ledger).toEqual(state.ledger);
  });

  it("edits and deletes wishes without removing redemption history", () => {
    const state = freshState();
    const wish = state.wishes.find((item) => item.id === "w4")!;
    const edited = saveWish(
      state,
      { ...wish, title: "加长睡前故事", pointsCost: 70 },
      wish.id,
    );
    const deleted = deleteWish(edited, wish.id);

    expect(edited.wishes.find((item) => item.id === wish.id)).toMatchObject({
      title: "加长睡前故事",
      pointsCost: 70,
      isActive: true,
    });
    expect(deleted.wishes.some((item) => item.id === wish.id)).toBe(false);
    expect(deleted.redemptions).toEqual(state.redemptions);
    expect(deleted.ledger).toEqual(state.ledger);
  });
});

describe("wish redemption", () => {
  it("deducts points and records a redemption immediately", () => {
    const state = freshState();
    const wish = state.wishes.find((item) => item.id === "w2")!;
    const balance = state.children[0].pointsBalance;

    const next = redeemWish(state, wish, fixedClock());

    expect(next.children[0].pointsBalance).toBe(balance - wish.pointsCost);
    expect(next.ledger[next.ledger.length - 1]).toMatchObject({
      amount: -wish.pointsCost,
      referenceId: wish.id,
    });
    expect(next.redemptions[next.redemptions.length - 1]).toMatchObject({
      wishId: wish.id,
      pointsCost: wish.pointsCost,
    });
  });

  it("does nothing when the balance is insufficient", () => {
    const state = freshState();
    const expensiveWish = state.wishes.find((item) => item.id === "w3")!;

    expect(redeemWish(state, expensiveWish, fixedClock())).toBe(state);
  });
});
