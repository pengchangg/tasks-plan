import { describe, expect, it } from "vitest";
import { seedState } from "./data";
import {
  dayActivity,
  dayDigest,
  deleteChild,
  deleteTask,
  deleteWish,
  familyDate,
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
    const added = saveChild(
      state,
      { name: "小安", avatar: "🌈", color: "#67a9dc" },
      undefined,
      fixedClock(),
    );
    const deleted = deleteChild(added, "mia");

    expect(deleted.activeChildId).toBe("child-1");
    expect(deleted.tasks.every((item) => item.childId !== "mia")).toBe(true);
    expect(deleted.submissions.every((item) => item.childId !== "mia")).toBe(
      true,
    );
    expect(deleted.ledger.every((item) => item.childId !== "mia")).toBe(true);
    expect(deleted.redemptions.every((item) => item.childId !== "mia")).toBe(
      true,
    );
    expect(deleteChild(deleted, "child-1")).toBe(deleted);
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

// 固定日期的本地 fixture：seedState 的日期在 import 时才算出来，测不了补录。
function dayState(): AppState {
  return {
    version: 1,
    timezone: "Asia/Shanghai",
    role: "child",
    activeChildId: "mia",
    children: [
      {
        id: "mia",
        name: "米娅",
        avatar: "🌻",
        color: "#ffb547",
        level: 1,
        experience: 0,
        pointsBalance: 10,
        streakDays: 0,
      },
      {
        id: "leo",
        name: "乐乐",
        avatar: "🚀",
        color: "#55b8a4",
        level: 1,
        experience: 0,
        pointsBalance: 40,
        streakDays: 0,
      },
    ],
    tasks: [
      {
        id: "d1",
        childId: "mia",
        title: "整理书桌",
        description: "",
        category: "生活自理",
        points: 20,
        repeatRule: "daily",
        dueDate: "2026-09-16",
        status: "completed",
        createdAt: "2026-09-16T00:00:00Z",
      },
      {
        id: "d2",
        childId: "mia",
        title: "阅读 20 分钟",
        description: "",
        category: "学习成长",
        points: 10,
        repeatRule: "daily",
        dueDate: "2026-09-16",
        status: "todo",
        createdAt: "2026-09-16T00:01:00Z",
      },
      {
        id: "d3",
        childId: "mia",
        title: "给植物浇水",
        description: "",
        category: "家庭责任",
        points: 15,
        repeatRule: "once",
        dueDate: "2026-09-12",
        status: "todo",
        createdAt: "2026-09-12T00:00:00Z",
      },
      {
        id: "d4",
        childId: "leo",
        title: "收拾玩具箱",
        description: "",
        category: "生活自理",
        points: 10,
        repeatRule: "daily",
        dueDate: "2026-09-16",
        status: "completed",
        createdAt: "2026-09-16T00:02:00Z",
      },
    ],
    submissions: [
      {
        id: "s1",
        taskId: "d1",
        childId: "mia",
        note: "",
        attachments: [],
        submittedAt: "2026-09-16T02:00:00Z",
        reviewedAt: "2026-09-16T02:05:00Z",
      },
      {
        id: "s2",
        taskId: "d3",
        childId: "mia",
        note: "",
        attachments: [],
        submittedAt: "2026-09-16T02:00:00Z",
      },
      {
        id: "s3",
        taskId: "d4",
        childId: "leo",
        note: "",
        attachments: [],
        submittedAt: "2026-09-16T02:00:00Z",
      },
    ],
    wishes: [],
    ledger: [
      {
        id: "l1",
        childId: "mia",
        amount: 5,
        type: "earned",
        referenceType: "task",
        referenceId: "d3",
        description: "",
        createdAt: "2026-09-14T02:00:00Z",
      },
      {
        id: "l2",
        childId: "mia",
        amount: 20,
        type: "earned",
        referenceType: "task",
        referenceId: "d1",
        description: "",
        createdAt: "2026-09-16T02:05:00Z",
      },
      {
        id: "l3",
        childId: "mia",
        amount: 30,
        type: "spent",
        referenceType: "redemption",
        referenceId: "w1",
        description: "",
        createdAt: "2026-09-16T02:06:00Z",
      },
      {
        id: "l4",
        childId: "leo",
        amount: 9,
        type: "earned",
        referenceType: "task",
        referenceId: "d4",
        description: "",
        createdAt: "2026-09-16T02:00:00Z",
      },
    ],
    redemptions: [],
  };
}

describe("day statistics", () => {
  it("converts an instant into the family's local date", () => {
    expect(familyDate("2026-09-15T17:30:00Z", "Asia/Shanghai")).toBe(
      "2026-09-16",
    );
    expect(familyDate("2026-09-15T17:30:00Z", "UTC")).toBe("2026-09-15");
  });

  it("collects the tasks scheduled on a day and the points earned that day", () => {
    const digest = dayDigest(dayState(), "mia", "2026-09-16");

    expect(digest.scheduled.map((entry) => entry.task.id)).toEqual(["d1", "d2"]);
    expect(digest.scheduled.map((entry) => entry.task.status)).toEqual([
      "completed",
      "todo",
    ]);
    expect(digest.scheduled[0].submissionDate).toBe("2026-09-16");
    expect(digest.earned).toBe(20);
  });

  it("lists a task submitted on another day under 补录 and keeps its own day marked", () => {
    const state = dayState();

    const submitted = dayDigest(state, "mia", "2026-09-16");
    expect(submitted.backfilled.map((entry) => entry.task.id)).toEqual(["d3"]);
    expect(submitted.backfilled[0].submissionDate).toBe("2026-09-16");

    const scheduled = dayDigest(state, "mia", "2026-09-12");
    expect(scheduled.scheduled.map((entry) => entry.task.id)).toEqual(["d3"]);
    expect(scheduled.scheduled[0].submissionDate).toBe("2026-09-16");
    expect(scheduled.backfilled).toEqual([]);
  });

  it("keeps only the newest submission of a task", () => {
    const state = dayState();
    state.submissions.push({
      id: "s4",
      taskId: "d3",
      childId: "mia",
      note: "",
      attachments: [],
      submittedAt: "2026-09-17T02:00:00Z",
    });

    expect(dayDigest(state, "mia", "2026-09-16").backfilled).toEqual([]);
    expect(
      dayDigest(state, "mia", "2026-09-17").backfilled.map(
        (entry) => entry.task.id,
      ),
    ).toEqual(["d3"]);
  });

  it("scopes a digest to one child", () => {
    const state = dayState();

    const mia = dayDigest(state, "mia", "2026-09-16");
    expect(mia.scheduled.some((entry) => entry.task.id === "d4")).toBe(false);
    expect(mia.backfilled.some((entry) => entry.task.id === "d4")).toBe(false);

    const leo = dayDigest(state, "leo", "2026-09-16");
    expect(leo.scheduled.map((entry) => entry.task.id)).toEqual(["d4"]);
    expect(leo.earned).toBe(9);
  });

  it("returns an empty digest for a day without records", () => {
    const digest = dayDigest(dayState(), "mia", "2026-01-01");

    expect(digest.scheduled).toEqual([]);
    expect(digest.backfilled).toEqual([]);
    expect(digest.earned).toBe(0);
  });

  it("summarizes per-day activity for the calendar", () => {
    const activity = dayActivity(dayState(), "mia");

    expect(activity["2026-09-16"]).toEqual({
      scheduled: 2,
      completed: 1,
      backfilled: 1,
    });
    expect(activity["2026-09-12"]).toEqual({
      scheduled: 1,
      completed: 0,
      backfilled: 0,
    });
    expect(activity["2026-09-14"]).toBeUndefined();
    expect(activity["2026-01-01"]).toBeUndefined();
  });
});
