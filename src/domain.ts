import type { AppState, Attachment, Child, Task, Wish } from "./types";

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
        childId: child.id,
        pointsCost: currentWish.pointsCost,
        createdAt,
      },
    ],
  };
}
