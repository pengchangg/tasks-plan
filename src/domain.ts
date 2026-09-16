import type {
  AppState,
  ChildInput,
  Task,
  TaskInput,
  TaskSubmission,
  WishInput,
} from "./types";

// 写请求体的类型只在 types.ts 定义一次，这里保留旧名字只为调用点可读。
export type ChildDraft = ChildInput;
export type TaskDraft = TaskInput;
export type WishDraft = WishInput;

export interface DayEntry {
  task: Task;
  submission?: TaskSubmission;
  submissionDate?: string;
}

export interface DayDigest {
  date: string;
  scheduled: DayEntry[];
  backfilled: DayEntry[];
  earned: number;
}

export interface DayActivity {
  scheduled: number;
  completed: number;
  backfilled: number;
}

// 家庭本地日期字符串的加减：只做 Y-M-D 的日历运算（Date.UTC 不会遇到夏令时
// 跳变或跨月天数），与设备时区无关。
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

// Intl 在给定 timeZone 下的 Y-M-D，与设备时区无关；空时区退回设备时区。
// timeZone 取值是运行期数据，所以缓存用 Map。
export function familyDate(instant: string, timezone: string): string {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timezone, formatter);
  }
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

// 客户端与服务端一致地「最后一条 submission 生效」：server 的 submissions
// 按 submitted_at 升序返回，所以后写覆盖先写。
function latestSubmissions(
  state: AppState,
  childId: string,
): Map<string, { submission: TaskSubmission; date: string }> {
  const latest = new Map<string, { submission: TaskSubmission; date: string }>();
  for (const submission of state.submissions) {
    if (submission.childId !== childId) continue;
    latest.set(submission.taskId, {
      submission,
      date: familyDate(submission.submittedAt, state.timezone),
    });
  }
  return latest;
}

export function dayDigest(
  state: AppState,
  childId: string,
  date: string,
): DayDigest {
  const latest = latestSubmissions(state, childId);
  const scheduled: DayEntry[] = [];
  const backfilled: DayEntry[] = [];
  for (const task of state.tasks) {
    if (task.childId !== childId) continue;
    const current = latest.get(task.id);
    const entry: DayEntry = {
      task,
      submission: current?.submission,
      submissionDate: current?.date,
    };
    if (task.dueDate === date) scheduled.push(entry);
    else if (current && current.date === date) backfilled.push(entry);
  }
  const earned = state.ledger
    .filter(
      (entry) =>
        entry.childId === childId &&
        entry.type === "earned" &&
        familyDate(entry.createdAt, state.timezone) === date,
    )
    .reduce((sum, entry) => sum + entry.amount, 0);
  return { date, scheduled, backfilled, earned };
}

// 日历圆点用：只返回有活动的日期，规则与 dayDigest 完全一致。
export function dayActivity(
  state: AppState,
  childId: string,
): Record<string, DayActivity> {
  const latest = latestSubmissions(state, childId);
  const activity: Record<string, DayActivity> = {};
  const bucket = (date: string) =>
    (activity[date] ??= { scheduled: 0, completed: 0, backfilled: 0 });
  for (const task of state.tasks) {
    if (task.childId !== childId) continue;
    const day = bucket(task.dueDate);
    day.scheduled += 1;
    if (task.status === "completed") day.completed += 1;
    const current = latest.get(task.id);
    if (current && current.date !== task.dueDate)
      bucket(current.date).backfilled += 1;
  }
  return activity;
}
