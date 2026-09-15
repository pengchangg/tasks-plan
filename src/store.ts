import { useCallback, useEffect, useMemo, useState } from "react";
import { seedState } from "./data";
import type { ChildDraft, TaskDraft, WishDraft } from "./domain";
import type { AppState, Attachment, Child, Wish } from "./types";

const demo = { familyCode: "DEMO", username: "parent" };
const emptyChild: Child = {
  id: "",
  name: "孩子",
  avatar: "✦",
  color: "#ffb547",
  level: 1,
  experience: 0,
  pointsBalance: 0,
  streakDays: 0,
};
type LoginProfile = Pick<Child, "id" | "name" | "avatar" | "color">;

type APIError = { error?: { code?: string; message?: string } };

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as APIError;
    throw new Error(detail.error?.message ?? `请求失败 (${response.status})`);
  }
  return response;
}

const json = (
  method: string,
  value?: unknown,
  idempotent = false,
): RequestInit => ({
  method,
  body: value === undefined ? undefined : JSON.stringify(value),
  headers: idempotent ? { "Idempotency-Key": crypto.randomUUID() } : undefined,
});

export function useAppStore() {
  const [state, setState] = useState<AppState>({ ...seedState, role: "child" });
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [profiles, setProfiles] = useState<LoginProfile[]>([]);
  const [message, setMessage] = useState("");
  const [stats, setStats] = useState({
    totalTasks: 0,
    completedTasks: 0,
    earnedPoints: 0,
    spentPoints: 0,
    daily: [] as { date: string; label: string; completed: number }[],
    categories: [] as { name: string; count: number; percent: number }[],
  });

  const refresh = useCallback(async () => {
    const [stateResponse, statsResponse] = await Promise.all([
      request("/state"),
      request("/stats"),
    ]);
    const next = (await stateResponse.json()) as AppState;
    setState(next);
    setStats(await statsResponse.json());
    setAuthenticated(true);
    setReady(true);
  }, []);

  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      try {
        setMessage("");
        await operation();
        await refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "操作失败，请重试");
      }
    },
    [refresh],
  );

  const loadProfiles = useCallback(async (familyCode: string) => {
    const response = await fetch(
      `/api/v1/auth/profiles?familyCode=${encodeURIComponent(familyCode)}`,
    );
    if (!response.ok) throw new Error("家庭码不存在");
    const result = (await response.json()) as LoginProfile[];
    setProfiles(result);
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = (await fetch("/api/v1/auth/status").then((response) =>
          response.json(),
        )) as { authenticated: boolean };
        if (status.authenticated) {
          await refresh();
          return;
        }
        try {
          if (!cancelled) await loadProfiles(demo.familyCode);
          if (!cancelled) setReady(true);
        } catch (error) {
          if (!cancelled) {
            setMessage(error instanceof Error ? error.message : "无法连接服务");
            setReady(true);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "无法连接服务");
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProfiles, refresh]);

  const activeChild =
    state.children.find((child) => child.id === state.activeChildId) ??
    state.children[0] ??
    emptyChild;
  const childTasks = useMemo(
    () => state.tasks.filter((task) => task.childId === activeChild.id),
    [state.tasks, activeChild.id],
  );

  const actions = {
    loginChild: async (familyCode: string, childId: string, pin: string) => {
      try {
        await request(
          "/auth/child",
          json("POST", { familyCode, childId, pin }),
        );
        await refresh();
        return true;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "登录失败");
        return false;
      }
    },
    loadProfiles: async (familyCode: string) => {
      try {
        setMessage("");
        return await loadProfiles(familyCode);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "家庭码不存在");
        return [];
      }
    },
    loginParent: async (
      password: string,
      familyCode = demo.familyCode,
      username = demo.username,
    ) => {
      try {
        await request(
          "/auth/parent",
          json("POST", {
            familyCode,
            username,
            password,
          }),
        );
        await refresh();
        return true;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "登录失败");
        return false;
      }
    },
    setRole: async (role: AppState["role"]) => {
      if (role === "parent") return;
      await run(() => request("/auth/switch-child", json("POST")));
    },
    setActiveChild: (childId: string) => {
      if (state.role === "parent") {
        void run(() => request("/session/child", json("PATCH", { childId })));
      } else {
        void (async () => {
          await request("/auth/logout", json("POST"));
          setAuthenticated(false);
          setProfiles(await loadProfiles(demo.familyCode));
        })();
      }
    },
    saveChild: (draft: ChildDraft, id?: string) =>
      void run(() =>
        request(`/children/${id ?? ""}`, json(id ? "PUT" : "POST", draft)),
      ),
    deleteChild: (id: string) =>
      void run(() => request(`/children/${id}`, json("DELETE"))),
    submitTask: (taskId: string, note: string, attachments: Attachment[]) =>
      void run(() => {
        const body = new FormData();
        body.set("note", note);
        for (const attachment of attachments) {
          if (attachment.file) body.append("files", attachment.file);
        }
        return request(`/tasks/${taskId}/submit`, {
          method: "POST",
          body,
          headers: { "Idempotency-Key": crypto.randomUUID() },
        });
      }),
    reviewTask: (taskId: string, approved: boolean, note = "") =>
      void run(() =>
        request(
          `/tasks/${taskId}/review`,
          json("POST", { approved, note }, true),
        ),
      ),
    redeemWish: (wish: Wish) =>
      void run(() =>
        request(`/wishes/${wish.id}/redeem`, json("POST", {}, true)),
      ),
    saveTask: (draft: TaskDraft, id?: string) =>
      void run(() =>
        request(`/tasks/${id ?? ""}`, json(id ? "PUT" : "POST", draft)),
      ),
    deleteTask: (id: string) =>
      void run(() => request(`/tasks/${id}`, json("DELETE"))),
    saveWish: (draft: WishDraft, id?: string) =>
      void run(() =>
        request(`/wishes/${id ?? ""}`, json(id ? "PUT" : "POST", draft)),
      ),
    deleteWish: (id: string) =>
      void run(() => request(`/wishes/${id}`, json("DELETE"))),
    toggleWish: (id: string) => {
      const wish = state.wishes.find((item) => item.id === id);
      if (wish)
        void run(() =>
          request(
            `/wishes/${id}`,
            json("PUT", {
              ...wish,
              isActive: !wish.isActive,
            }),
          ),
        );
    },
  };
  return {
    state,
    activeChild,
    childTasks,
    actions,
    ready,
    authenticated,
    profiles,
    message,
    stats,
  };
}
