import type {
  AppState,
  Attachment,
  Child,
  Task,
  TaskSubmission,
  Wish,
} from "./types";

export type ChildDraft = Pick<Child, "name" | "avatar" | "color">;
export type TaskDraft = Pick<
  Task,
  "childId" | "title" | "description" | "category" | "points" | "repeatRule"
>;
export type WishDraft = Omit<Wish, "id">;

export interface DomainClock {
  id: (prefix: string) => string;
  now: () => string;
}

const defaultClock: DomainClock = {
  id: (prefix) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  now: () => new Date().toISOString(),
};

export function submitTask(
  state: AppState,
  taskId: string,
  note: string,
  attachments: Attachment[],
  clock: DomainClock = defaultClock,
): AppState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (
    !task ||
    task.childId !== state.activeChildId ||
    !["todo", "rejected"].includes(task.status)
  )
    return state;

  return {
    ...state,
    tasks: state.tasks.map((item) =>
      item.id === taskId ? { ...item, status: "pending_review" } : item,
    ),
    submissions: [
      ...state.submissions,
      {
        id: clock.id("submission"),
        taskId,
        childId: state.activeChildId,
        note,
        attachments,
        submittedAt: clock.now(),
      },
    ],
  };
}

export function reviewTask(
  state: AppState,
  taskId: string,
  approved: boolean,
  note = "",
  clock: DomainClock = defaultClock,
): AppState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.status !== "pending_review") return state;

  let submission = undefined;
  for (let index = state.submissions.length - 1; index >= 0; index -= 1) {
    const candidate = state.submissions[index];
    if (candidate.taskId === taskId && !candidate.reviewedAt) {
      submission = candidate;
      break;
    }
  }
  if (!submission) return state;

  const reviewedAt = clock.now();
  const updatedTask: Task = {
    ...task,
    status: approved ? "completed" : "rejected",
  };
  const tasks = state.tasks.map((item) =>
    item.id === taskId ? updatedTask : item,
  );
  const submissions = state.submissions.map((item) =>
    item.id === submission.id
      ? { ...item, reviewedAt, reviewNote: note }
      : item,
  );

  if (!approved) return { ...state, tasks, submissions };

  const alreadyCredited = state.ledger.some(
    (item) => item.referenceId === taskId && item.type === "earned",
  );
  if (alreadyCredited) return { ...state, tasks, submissions };

  return {
    ...state,
    tasks,
    submissions,
    children: state.children.map((child) => {
      if (child.id !== task.childId) return child;
      const growth = Math.max(1, Math.floor(task.points / 5));
      const experienceTotal =
        (child.level - 1) * 100 + child.experience + growth;
      return {
        ...child,
        pointsBalance: child.pointsBalance + task.points,
        level: 1 + Math.floor(experienceTotal / 100),
        experience: experienceTotal % 100,
      };
    }),
    ledger: [
      ...state.ledger,
      {
        id: clock.id("ledger"),
        childId: task.childId,
        amount: task.points,
        type: "earned",
        referenceId: taskId,
        description: `完成「${task.title}」`,
        createdAt: reviewedAt,
      },
    ],
  };
}

export function saveChild(
  state: AppState,
  draft: ChildDraft,
  childId?: string,
  clock: DomainClock = defaultClock,
): AppState {
  const name = draft.name.trim();
  if (!name || !draft.avatar.trim()) return state;

  if (childId) {
    if (!state.children.some((child) => child.id === childId)) return state;
    return {
      ...state,
      children: state.children.map((child) =>
        child.id === childId ? { ...child, ...draft, name } : child,
      ),
    };
  }

  const child: Child = {
    id: clock.id("child"),
    name,
    avatar: draft.avatar,
    color: draft.color,
    level: 1,
    experience: 0,
    pointsBalance: 0,
    streakDays: 0,
  };
  return {
    ...state,
    children: [...state.children, child],
    activeChildId: child.id,
  };
}

export function deleteChild(state: AppState, childId: string): AppState {
  if (
    state.children.length <= 1 ||
    !state.children.some((child) => child.id === childId)
  )
    return state;

  const children = state.children.filter((child) => child.id !== childId);
  return {
    ...state,
    activeChildId:
      state.activeChildId === childId ? children[0].id : state.activeChildId,
    children,
    tasks: state.tasks.filter((task) => task.childId !== childId),
    submissions: state.submissions.filter(
      (submission) => submission.childId !== childId,
    ),
    ledger: state.ledger.filter((entry) => entry.childId !== childId),
    redemptions: state.redemptions.filter(
      (redemption) => redemption.childId !== childId,
    ),
  };
}

export function saveTask(
  state: AppState,
  draft: TaskDraft,
  taskId?: string,
  clock: DomainClock = defaultClock,
): AppState {
  const title = draft.title.trim();
  if (!title || draft.points < 1) return state;
  if (taskId) {
    if (!state.tasks.some((task) => task.id === taskId)) return state;
    return {
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, ...draft, title } : task,
      ),
    };
  }
  return {
    ...state,
    tasks: [
      {
        id: clock.id("task"),
        ...draft,
        title,
        dueDate: clock.now().slice(0, 10),
        status: "todo",
        createdAt: clock.now(),
      },
      ...state.tasks,
    ],
  };
}

export function deleteTask(state: AppState, taskId: string): AppState {
  if (!state.tasks.some((task) => task.id === taskId)) return state;
  return {
    ...state,
    tasks: state.tasks.filter((task) => task.id !== taskId),
    submissions: state.submissions.filter(
      (submission) => submission.taskId !== taskId,
    ),
  };
}

export function saveWish(
  state: AppState,
  draft: WishDraft,
  wishId?: string,
  clock: DomainClock = defaultClock,
): AppState {
  const title = draft.title.trim();
  if (!title || draft.pointsCost < 1) return state;
  if (wishId) {
    if (!state.wishes.some((wish) => wish.id === wishId)) return state;
    return {
      ...state,
      wishes: state.wishes.map((wish) =>
        wish.id === wishId ? { ...wish, ...draft, title } : wish,
      ),
    };
  }
  return {
    ...state,
    wishes: [{ id: clock.id("wish"), ...draft, title }, ...state.wishes],
  };
}

export function deleteWish(state: AppState, wishId: string): AppState {
  if (!state.wishes.some((wish) => wish.id === wishId)) return state;
  return {
    ...state,
    wishes: state.wishes.filter((wish) => wish.id !== wishId),
  };
}

export function redeemWish(
  state: AppState,
  wish: Wish,
  clock: DomainClock = defaultClock,
): AppState {
  const child = state.children.find((item) => item.id === state.activeChildId);
  const currentWish = state.wishes.find((item) => item.id === wish.id);
  if (
    !child ||
    !currentWish?.isActive ||
    child.pointsBalance < currentWish.pointsCost
  )
    return state;

  const createdAt = clock.now();
  return {
    ...state,
    children: state.children.map((item) =>
      item.id === child.id
        ? {
            ...item,
            pointsBalance: item.pointsBalance - currentWish.pointsCost,
          }
        : item,
    ),
    ledger: [
      ...state.ledger,
      {
        id: clock.id("ledger"),
        childId: child.id,
        amount: -currentWish.pointsCost,
        type: "spent",
        referenceId: currentWish.id,
        description: `兑换「${currentWish.title}」`,
        createdAt,
      },
    ],
    redemptions: [
      ...state.redemptions,
      {
        id: clock.id("redemption"),
        wishId: currentWish.id,
        wishTitle: currentWish.title,
        wishIcon: currentWish.icon,
        wishColor: currentWish.color,
        childId: child.id,
        pointsCost: currentWish.pointsCost,
        attachments: [],
        createdAt,
      },
    ],
  };
}

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
