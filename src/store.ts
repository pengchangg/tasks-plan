import { useCallback, useEffect, useMemo, useState } from "react";
import { seedState } from "./data";
import type { ChildDraft, TaskDraft, WishDraft } from "./domain";
import type {
  AppState,
  Attachment,
  Child,
  TaskSubmission,
  Wish,
} from "./types";

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

type APIError = { error?: { code?: string; message?: string } };

// The server answers snake_case codes with English text; screens are Chinese,
// so the codes they can actually hit are translated here.
const messages: Record<string, string> = {
  no_family: "还没有创建家庭：请先运行 serve --demo，或用 admin create-family 创建。",
  invalid_credentials: "密码不正确",
  too_many_requests: "尝试太频繁了，请稍后再试",
  forbidden: "这个操作需要家长密码",
  insufficient_points: "积分不足，无法兑换",
  wish_unavailable: "这个愿望暂时无法兑换",
  invalid_state: "当前状态不能完成这个操作，请刷新后再试",
  not_found: "内容已经不存在了，请刷新后再试",
  conflict: "操作冲突，请刷新后再试",
  last_child: "至少要保留一个孩子",
  upload_too_large: "文件太大了",
  unsupported_media: "只支持 JPEG/PNG/WebP 图片和 MP4/WebM 视频",
  too_many_files: "一次最多上传 6 个文件",
  upload_failed: "上传失败了，请重试",
  unavailable: "服务正忙，请稍后再试",
  internal: "服务出错了，请稍后再试",
};

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function describe(error: unknown, fallback: string) {
  if (error instanceof RequestError && messages[error.code])
    return messages[error.code];
  return error instanceof Error && error.message ? error.message : fallback;
}

// crypto.randomUUID is exposed only in a secure context, and the app is also
// served over plain HTTP on a LAN address, where the browser reports
// isSecureContext false and the method is undefined. getRandomValues is not
// gated that way, so build the (v4) UUID from it rather than letting every
// idempotent write throw before it reaches fetch.
function idempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const json = (
  method: string,
  value?: unknown,
  idempotent = false,
): RequestInit => ({
  method,
  body: value === undefined ? undefined : JSON.stringify(value),
  headers: idempotent ? { "Idempotency-Key": idempotencyKey() } : undefined,
});

async function send(path: string, init?: RequestInit) {
  return fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...init?.headers },
  });
}

async function request(path: string, init?: RequestInit) {
  let response = await send(path, init);
  if (response.status === 401 && !path.startsWith("/auth/")) {
    // The session expired, or the profile it pointed at is gone. The child end
    // is always available, so open a fresh one and replay the request once.
    await send("/auth/child", { method: "POST" });
    response = await send(path, init);
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as APIError;
    throw new RequestError(
      detail.error?.code ?? "",
      detail.error?.message ?? `请求失败 (${response.status})`,
    );
  }
  return response;
}

export function useAppStore() {
  const [state, setState] = useState<AppState>({ ...seedState, role: "child" });
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
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
    setState((await stateResponse.json()) as AppState);
    setStats(await statsResponse.json());
  }, []);

  // connect opens the child end, the app's default view. It runs on every page
  // load: the parent end is a per-visit elevation, so a reload always lands
  // back here and asks for the password again.
  const connect = useCallback(async () => {
    try {
      await request("/auth/child", { method: "POST" });
      await refresh();
      setMessage("");
      setConnected(true);
    } catch (error) {
      setConnected(false);
      setMessage(describe(error, "无法连接服务"));
    } finally {
      setReady(true);
    }
  }, [refresh]);

  useEffect(() => {
    void connect();
  }, [connect]);

  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      try {
        setMessage("");
        await operation();
        await refresh();
      } catch (error) {
        setMessage(describe(error, "操作失败，请重试"));
      }
    },
    [refresh],
  );

  const activeChild =
    state.children.find((child) => child.id === state.activeChildId) ??
    state.children[0] ??
    emptyChild;
  const childTasks = useMemo(
    () => state.tasks.filter((task) => task.childId === activeChild.id),
    [state.tasks, activeChild.id],
  );

  // The newest submission per task for the child on screen; the server orders
  // submissions by submitted_at, so the last one wins.
  const latestSubmissions = useMemo(() => {
    const byTask = new Map<string, TaskSubmission>();
    for (const submission of state.submissions) {
      if (submission.childId === activeChild.id)
        byTask.set(submission.taskId, submission);
    }
    return byTask;
  }, [state.submissions, activeChild.id]);

  const actions = {
    reconnect: connect,
    unlockParent: async (password: string) => {
      try {
        await request("/auth/parent", json("POST", { password }));
        await refresh();
        setMessage("");
        return true;
      } catch (error) {
        // The modal shows its own wrong-password text; anything else
        // (throttling, a missing family) needs the shared banner.
        if (
          !(error instanceof RequestError) ||
          error.code !== "invalid_credentials"
        )
          setMessage(describe(error, "无法进入家长端"));
        return false;
      }
    },
    enterChild: () =>
      void run(() => request("/auth/child", { method: "POST" })),
    setActiveChild: (childId: string) =>
      void run(() => request("/session/child", json("PATCH", { childId }))),
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
          headers: { "Idempotency-Key": idempotencyKey() },
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
    latestSubmissions,
    actions,
    ready,
    connected,
    message,
    stats,
    dismissMessage: () => setMessage(""),
  };
}
