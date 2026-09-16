import { describe, expect, it } from "vitest";
import { dayActivity, dayDigest, familyDate, shiftDate } from "./domain";
import type { AppState } from "./types";

// 固定日期的本地 fixture：日期全部写死，才能表达「补录」这类跟今天无关的场景。
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
        repeatWeekday: 1,
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
        repeatWeekday: 1,
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
        repeatWeekday: 1,
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
        repeatWeekday: 1,
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

describe("shiftDate", () => {
  it("steps across a month boundary", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("steps across a leap day", () => {
    expect(shiftDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDate("2025-02-28", 1)).toBe("2025-03-01");
  });
});
