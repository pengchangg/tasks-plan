import { useCallback, useEffect, useMemo, useState } from "react";
import { seedState } from "./data";
import {
  deleteChild as deleteChildState,
  deleteTask as deleteTaskState,
  deleteWish as deleteWishState,
  reviewTask as reviewTaskState,
  redeemWish as redeemWishState,
  saveChild as saveChildState,
  saveTask as saveTaskState,
  saveWish as saveWishState,
  submitTask as submitTaskState,
} from "./domain";
import type { ChildDraft, TaskDraft, WishDraft } from "./domain";
import type { AppState, Attachment, Wish } from "./types";

const STORAGE_KEY = "growjoy-state-v1";

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AppState) : seedState;
  } catch {
    return seedState;
  }
}

export function useAppStore() {
  const [state, setState] = useState<AppState>(loadState);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);
  const update = useCallback(
    (fn: (current: AppState) => AppState) => setState((current) => fn(current)),
    [],
  );
  const activeChild =
    state.children.find((child) => child.id === state.activeChildId) ??
    state.children[0];
  const childTasks = useMemo(
    () => state.tasks.filter((task) => task.childId === activeChild.id),
    [state.tasks, activeChild.id],
  );

  const actions = {
    setRole: (role: AppState["role"]) => update((s) => ({ ...s, role })),
    setActiveChild: (id: string) =>
      update((s) => ({ ...s, activeChildId: id })),
    saveChild: (draft: ChildDraft, id?: string) =>
      update((s) => saveChildState(s, draft, id)),
    deleteChild: (id: string) => update((s) => deleteChildState(s, id)),
    submitTask: (taskId: string, note: string, attachments: Attachment[]) =>
      update((s) => submitTaskState(s, taskId, note, attachments)),
    reviewTask: (taskId: string, approved: boolean, note = "") =>
      update((s) => reviewTaskState(s, taskId, approved, note)),
    redeemWish: (wish: Wish) => update((s) => redeemWishState(s, wish)),
    saveTask: (draft: TaskDraft, id?: string) =>
      update((s) => saveTaskState(s, draft, id)),
    deleteTask: (id: string) => update((s) => deleteTaskState(s, id)),
    saveWish: (draft: WishDraft, id?: string) =>
      update((s) => saveWishState(s, draft, id)),
    deleteWish: (id: string) => update((s) => deleteWishState(s, id)),
    toggleWish: (id: string) =>
      update((s) => ({
        ...s,
        wishes: s.wishes.map((w) =>
          w.id === id ? { ...w, isActive: !w.isActive } : w,
        ),
      })),
    reset: () => setState(seedState),
  };
  return { state, activeChild, childTasks, actions };
}
