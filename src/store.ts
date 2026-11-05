import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { seedState } from "./data";
import { familyDate } from "./domain";
import type { ChildDraft, TaskDraft, WishDraft } from "./domain";
import type {
  AppState,
  Attachment,
  Child,
  HomeworkDay,
  HomeworkDraft,
  HomeworkPendingItem,
  StatsPayload,
  TaskSubmission,
  Wish,
  WishInput,
} from "./types";

const emptyChild: Child = {
  id: "",
  name: "孩子",
  avatar: "🌻",
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
  unauthorized: "登录状态已经失效，请重新进入。",
  idempotency_required: "请求缺少幂等键，请刷新后重试",
  too_many_requests: "尝试太频繁了，请稍后再试",
  forbidden: "这个操作需要家长密码",
  insufficient_points: "积分不足，无法兑换",
  insufficient_balance: "孩子当前积分不足，无法扣除",
  wish_unavailable: "这个愿望暂时无法兑换",
  invalid_request: "提交的内容不合法，请检查后重试",
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
  cross_site_request: "跨站请求被拒绝了，请从本站页面重试",
  origin_mismatch: "请求来源和本站不一致，请检查访问地址",
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

// 完成勾选的回执：awarded 是服务端算出的积分增减，pending 表示这一勾还在等家长确认。
type HomeworkToggle = { awarded: number; pending: boolean };

// 两端在同一块屏上轮流用，孩子提交完就走开、家长却可能还在自己那一页上，
// 所以屏幕要自己动：每 60 秒静默重拉一次（只在页面可见时）。
const autoRefreshMs = 60_000;

export function useAppStore() {
  const [state, setState] = useState<AppState>({ ...seedState, role: "child" });
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  // 成功和失败共用一条横幅，但样式必须不同：保存成功不该长得像报错。
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const setMessage = useCallback(
    (text: string) => setNotice(text ? { text, ok: false } : null),
    [],
  );
  const setOkMessage = useCallback(
    (text: string) => setNotice({ text, ok: true }),
    [],
  );
  // 家庭总览用默认区间（最近 7 天）；成长统计页按自己选的区间单独取，不覆盖它。
  const [stats, setStats] = useState<StatsPayload>({
    from: "",
    to: "",
    totalTasks: 0,
    completedTasks: 0,
    earnedPoints: 0,
    spentPoints: 0,
    daily: [],
    categories: [],
  });
  // 作业按日期浏览：date 为空表示还没加载过，页面挂载时用家庭本地的今天填上。
  const [homework, setHomework] = useState<HomeworkDay>({
    date: "",
    items: [],
  });
  // 待确认作业不进 /state：它是家长总览上的一小排，孩子端一辈子用不上一次。
  const [homeworkPending, setHomeworkPending] = useState<
    HomeworkPendingItem[]
  >([]);

  // keepRole 给静默轮询用：家长会话在后台过期时 request() 会顺手改开孩子端，
  // 一次没人看的重拉不能因此把家长从当前页面踢走（正在填的表单会一起没了）。
  const pull = useCallback(async (keepRole: boolean) => {
    // 待确认列表只给家长总览看，拉失败不影响这一屏：保留上一次的行比空一下好。
    const [stateResponse, statsResponse, pendingResponse] = await Promise.all([
      request("/state"),
      request("/stats"),
      request("/homework/pending").catch(() => null),
    ]);
    const next = (await stateResponse.json()) as AppState;
    setStats(await statsResponse.json());
    if (pendingResponse?.ok)
      setHomeworkPending((await pendingResponse.json()) as HomeworkPendingItem[]);
    setState((prev) => (!keepRole || prev.role === next.role ? next : prev));
  }, []);

  const refresh = useCallback(() => pull(false), [pull]);

  // 作业与任务不同：它按「看的是哪一天」取，所以载荷不进 /state，而是单独一个端点，
  // 由 homework.date 决定当前这一天。失败时保留上一次的内容并提示，并返回 false：
  // 要用这个结果的调用方（保存/删除）不能把失败当成成功再盖一句「已保存」。
  // 序号让后发的请求赢。
  const homeworkAttempt = useRef(0);

  const loadHomework = useCallback(async (date: string) => {
    const attempt = ++homeworkAttempt.current;
    try {
      const response = await request(`/homework/?date=${date}`);
      const payload = (await response.json()) as HomeworkDay;
      if (attempt === homeworkAttempt.current) setHomework(payload);
      return true;
    } catch (error) {
      setMessage(describe(error, "加载作业失败"));
      return false;
    }
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

  useEffect(() => {
    if (!ready || !connected) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        await pull(true);
      } catch {
        // 静默：屏幕上的旧数据比一句凭空冒出来的报错有用，下一轮再试。
      }
    };
    const timer = window.setInterval(() => void tick(), autoRefreshMs);
    return () => window.clearInterval(timer);
  }, [ready, connected, pull]);

  const run = useCallback(
    // 把操作结果透出来（失败时是 undefined），勾作业才拿得到服务端算出的 awarded。
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      try {
        setMessage("");
        const result = await operation();
        await refresh();
        return result;
      } catch (error) {
        setMessage(describe(error, "操作失败，请重试"));
        return undefined;
      }
    },
    [refresh],
  );

  const activeChild =
    state.children.find((child) => child.id === state.activeChildId) ??
    state.children[0] ??
    emptyChild;
  // 任务列表（孩子端首页/任务页、家长端总览/任务管理）只列当前要处理的任务：已经
  // 确认完成的过往实例属于历史，由成长日历按天呈现，否则它们会挤满列表、也会把
  // 「今日完成 n/m」的分母算错。待完成/待确认/退回的实例无论落在哪天都留着，家长
  // 隔天才能确认的提交不会被藏起来。
  const today = familyDate(new Date().toISOString(), state.timezone);
  const childTasks = useMemo(
    () =>
      state.tasks.filter(
        (task) =>
          task.childId === activeChild.id &&
          !(task.status === "completed" && task.dueDate < today),
      ),
    [state.tasks, activeChild.id, today],
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

  // The child on screen owns this list; the server returns redemptions oldest
  // first, so reverse it for display.
  const childRedemptions = useMemo(
    () =>
      state.redemptions
        .filter((redemption) => redemption.childId === activeChild.id)
        .reverse(),
    [state.redemptions, activeChild.id],
  );

  const actions = {
    reconnect: connect,
    // 手动刷新：run 会重拉 /state 与 /stats，这里顺带把当前浏览的作业日期也重载一遍。
    // 数据通常和屏幕上一样，所以要给一句「已刷新」，否则按钮看起来没反应。
    // 提示放在作业重载之前，它失败时能用错误信息覆盖掉这句成功提示；
    // 它只是个回执，2 秒后自己收掉（别把已换成别的提示的报错一起清掉）。
    refresh: () =>
      void run(async () => {
        setOkMessage("已刷新");
        if (homework.date) await loadHomework(homework.date);
        window.setTimeout(
          () =>
            setNotice((current) => (current?.text === "已刷新" ? null : current)),
          2000,
        );
      }),
    // 成长统计页按区间读取。失败时返回 null，页面保留上一次的数字，
    // 不把总览的 7 天口径改掉。
    loadStats: async (from: string, to: string) => {
      try {
        const response = await request(`/stats?from=${from}&to=${to}`);
        return (await response.json()) as StatsPayload;
      } catch (error) {
        setMessage(describe(error, "加载统计失败"));
        return null;
      }
    },
    unlockParent: async (password: string) => {
      try {
        await request("/auth/parent", json("POST", { password }));
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
      // 密码已经对、会话已经建好：之后的重拉失败不能再报「密码不正确」，否则家长
      // 会一遍遍重输一个正确的密码。只是这一屏的数字是旧的。
      try {
        await refresh();
        setMessage("");
      } catch {
        setMessage("已进入家长端，但数据刷新失败，请点右上角刷新");
      }
      return true;
    },
    changeParentPassword: async (
      currentPassword: string,
      newPassword: string,
    ) => {
      try {
        await request(
          "/auth/parent/password",
          json("POST", { currentPassword, newPassword }),
        );
        setOkMessage("家长密码已更新");
        return true;
      } catch (error) {
        // 当前密码错误由弹窗自己提示，其余（限流、内部错误）走顶部横幅。
        if (
          !(error instanceof RequestError) ||
          error.code !== "invalid_credentials"
        )
          setMessage(describe(error, "无法修改家长密码"));
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
    awardPoints: (childId: string, amount: number, note = "") =>
      void run(() =>
        request(
          `/children/${childId}/points`,
          json("POST", { amount, note }, true),
        ),
      ),
    // 孩子端一键提交：服务端仍接受 note/files，但任务卡不再收集证据，所以这里
    // 只发一个空 note 保证请求体是 multipart（非 multipart 会被 413 拒掉）。
    submitTask: (taskId: string) =>
      run(() => {
        const body = new FormData();
        body.set("note", "");
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
    // 待确认一排十几条，逐条点太慢。批量不新增端点：逐条 POST 同一条 review 路由，
    // json(..., true) 每条现生成 Idempotency-Key，所以恰好一次的保证跟手动确认一模一样。
    // 另一端已经先确认过的那一条会拿 409，计个数接着走，循环里的失败不当整批失败。
    reviewAll: (taskIds: string[]) =>
      run(async () => {
        let approved = 0;
        let skipped = 0;
        for (const taskId of taskIds) {
          try {
            await request(
              `/tasks/${taskId}/review`,
              json("POST", { approved: true, note: "" }, true),
            );
            approved += 1;
          } catch {
            skipped += 1;
          }
        }
        setOkMessage(
          skipped
            ? `已确认 ${approved} 项，${skipped} 项没能确认`
            : `已确认 ${approved} 项`,
        );
        return { approved, skipped };
      }),
    redeemWish: (wish: Wish) =>
      void run(() =>
        request(`/wishes/${wish.id}/redeem`, json("POST", {}, true)),
      ),
    toggleRedemption: (
      id: string,
      completed: boolean,
      note = "",
      attachments: Attachment[] = [],
    ) =>
      void run(() => {
        const body = new FormData();
        body.set("completed", completed ? "true" : "false");
        if (note) body.set("note", note);
        for (const attachment of attachments) {
          if (attachment.file) body.append("files", attachment.file);
        }
        return request(`/redemptions/${id}`, { method: "PATCH", body });
      }),
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
      if (!wish) return;
      // 只发写接口认得的字段：wishInput 没有 id，而服务端的 decode() 拒绝未知字段。
      const body: WishInput = {
        title: wish.title,
        description: wish.description,
        pointsCost: wish.pointsCost,
        icon: wish.icon,
        color: wish.color,
        isActive: !wish.isActive,
      };
      void run(() => request(`/wishes/${id}`, json("PUT", body)));
    },
    setHomeworkDate: (date: string) => void loadHomework(date),
    // 作业是 multipart 写入：字段名与 Go 侧的 FormValue/Value 一一对应，files 与
    // remove_media 都是可重复字段。成功提示在操作内部 setMessage，否则会被 run 的
    // 通用失败文案/空文案覆盖。
    saveHomework: (draft: HomeworkDraft, id?: string) =>
      void run(async () => {
        const body = new FormData();
        body.set("date", draft.date);
        body.set("end_date", draft.endDate || draft.date);
        body.set("subject", draft.subject);
        body.set("description", draft.description);
        // 不确认的作业孩子勾上就当场给分，所以这个字段得跟着表单走（缺省由服务端当 1）。
        body.set("needs_confirm", draft.needsConfirm === false ? "false" : "true");
        for (const file of draft.files) body.append("files", file);
        for (const mediaId of draft.removeMedia) {
          body.append("remove_media", mediaId);
        }
        const response = await request(`/homework/${id ?? ""}`, {
          method: id ? "PUT" : "POST",
          body,
        });
        const saved = (await response.json()) as {
          id: string;
          skipped?: string[];
        };
        // 表单里的日期可能被改过，列表跟着它走。
        const loaded = await loadHomework(draft.date);
        // 重新读失败时那句错误横幅就是唯一要说的话，别再盖一句「已保存」。
        if (loaded)
          setOkMessage(
            saved.skipped?.length
              ? `已保存，但跳过了 ${saved.skipped.length} 个不支持的文件：${saved.skipped.join("、")}`
              : "作业已保存",
          );
      }),
    deleteHomework: (id: string) =>
      void run(async () => {
        await request(`/homework/${id}`, json("DELETE"));
        if (await loadHomework(homework.date)) setOkMessage("作业已删除");
      }),
    // 完成勾选按「看的那一天」记录，所以假期作业可以逐天勾；勾上每科 +5、当天全部
    // 完成再 +5（服务端算账）。先把本地那一行翻过来（重新读整天的作业会让受控勾选
    // 在往返期间跳回未勾），再发这次写入，并把服务端算出的 awarded/pending 回给
    // 调用方，让那张卡自己标出加了几分或「待家长确认」；加分另有奖励横幅，取消完成
    // 没有横幅、用提示说明，而待确认不值得报错。
    toggleHomeworkDone: (
      id: string,
      done: boolean,
    ): Promise<HomeworkToggle | undefined> => {
      const date = homework.date;
      setHomework((prev) => ({
        ...prev,
        items: prev.items.map((item) =>
          item.id === id ? { ...item, done } : item,
        ),
      }));
      return run(async () => {
        const response = await request(
          `/homework/${id}/done`,
          json("POST", { date, done }),
        );
        const { awarded = 0, pending = false } = (await response.json()) as {
          awarded?: number;
          pending?: boolean;
        };
        if (awarded < 0) setOkMessage(`已取消完成，扣回 ${-awarded} 积分`);
        return { awarded, pending };
      });
    },
    // 家长在总览上确认（或取消）孩子勾过的那一天：走同一个 done 端点，服务端把
    // confirmed_at 补上并结算积分，所以这里不新增写接口。
    confirmHomework: (homeworkId: string, date: string, ok: boolean) =>
      void run(async () => {
        await request(
          `/homework/${homeworkId}/done`,
          json("POST", { date, done: ok }),
        );
        setOkMessage(ok ? "作业已确认" : "已取消这一天的完成");
      }),
  };
  return {
    state,
    activeChild,
    childTasks,
    latestSubmissions,
    childRedemptions,
    actions,
    ready,
    connected,
    message: notice?.text ?? "",
    messageOk: notice?.ok ?? false,
    stats,
    today,
    homework,
    homeworkPending,
    dismissMessage: () => setNotice(null),
  };
}
