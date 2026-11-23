import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  ChevronRight,
  ClipboardCheck,
  Coins,
  Gift,
  Gamepad2,
  Home,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Menu,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
  Trophy,
  UserPlus,
  Users,
  Video,
  X,
} from "lucide-react";
import { useAppStore } from "./store";
import {
  dayActivity,
  dayDigest,
  familyDate,
  familyTime,
} from "./domain";
import type { DayActivity, DayEntry } from "./domain";
import { lunarFestival, lunarLabel, lunarMonthDay, restMark } from "./lunar";
import {
  ConfirmModal,
  EmptyState,
  LunarTag,
  Metric,
  PageHeading,
  ParentHeader,
  SectionTitle,
  StarMark,
  useDialog,
  ZoomableImage,
} from "./ui";
import {
  ChildHomework,
  ParentHomework,
  TodayHomework,
} from "./features/homework";
import {
  ChildGames,
  GameTeaser,
  KlotskiGame,
  ParentGames,
} from "./features/games";
import { CalcSprint, PatternQuiz } from "./features/quiz";
import { ChildLedger } from "./features/ledger";
import { ParentStats } from "./features/stats";
import type {
  Attachment,
  Child,
  HolidaySpan,
  PointLedger,
  Redemption,
  RepeatRule,
  Task,
  TaskSubmission,
  Wish,
} from "./types";
import "./styles.css";

const categories = ["全部", "生活自理", "学习成长", "家庭责任"];
// 星期的短名，顺序就是周日..周六（和 repeat_weekday / repeat_weekdays 里的数字同口径）。
const weekdayShort = ["日", "一", "二", "三", "四", "五", "六"];
// 新建任务时摆上一排能照着抄的推荐——对着空白表单想点子才是家长真正卡住的地方。
// 只做前端：点一下把字段填好，保存仍走 POST /tasks/，服务端没有新资源也没有新列。
const taskPresets: {
  category: string;
  items: {
    title: string;
    description: string;
    points: number;
    repeatRule: RepeatRule;
  }[];
}[] = [
  {
    category: "生活自理",
    items: [
      { title: "自己穿衣", description: "自己穿好衣服和鞋子", points: 10, repeatRule: "daily" },
      { title: "自己整理书包", description: "按明天的课表把书包收好", points: 10, repeatRule: "daily" },
      { title: "饭后收自己的碗", description: "吃完饭把自己的碗放到水池", points: 10, repeatRule: "daily" },
      { title: "叠自己的衣服", description: "洗完的衣服叠好放进柜子", points: 10, repeatRule: "weekly" },
      { title: "整理玩具角", description: "玩具全部归位，地垫收干净", points: 15, repeatRule: "weekly" },
    ],
  },
  {
    category: "学习成长",
    items: [
      { title: "阅读 20 分钟", description: "自己选一本书安静读完", points: 20, repeatRule: "daily" },
      { title: "朗读课文一遍", description: "大声读给家长听", points: 15, repeatRule: "daily" },
      { title: "口算 10 题", description: "计时做完再一起对答案", points: 15, repeatRule: "daily" },
      { title: "讲一件今天的事", description: "用自己的话说说今天发生了什么", points: 10, repeatRule: "daily" },
      { title: "拼图或积木 15 分钟", description: "自己完成一个作品", points: 10, repeatRule: "weekly" },
    ],
  },
  {
    category: "家庭责任",
    items: [
      { title: "倒垃圾", description: "把家里的垃圾送到楼下", points: 10, repeatRule: "daily" },
      { title: "给植物浇水", description: "看看土干了再浇，不要溢出来", points: 10, repeatRule: "daily" },
      { title: "擦桌子", description: "吃完饭把桌子擦干净", points: 10, repeatRule: "daily" },
      { title: "帮忙拿拖鞋", description: "有人回家就把拖鞋放到脚边", points: 10, repeatRule: "daily" },
      { title: "扫地", description: "把自己座位四周扫干净", points: 15, repeatRule: "weekly" },
    ],
  },
];
// 到账横幅的标题：台账 referenceType 决定该怎么称呼这笔积分。
const rewardTitles: Record<string, string> = {
  manual: "家长奖励",
  homework: "作业完成",
  homework_bonus: "当天作业全部完成",
  game: "游戏奖励",
};
const statusLabel = {
  todo: "待完成",
  pending_review: "待确认",
  completed: "已完成",
  rejected: "再试一次",
};
// 连续打卡徽章：阈值就是「连续天数」本身（streaks 由服务端从今天往回逐日数），
// 名字/图案是纯展示，不进任何计算。
const streakBadges = [
  { days: 3, icon: "🌱", name: "小芽" },
  { days: 7, icon: "🌿", name: "新叶" },
  { days: 14, icon: "🌳", name: "小树" },
  { days: 30, icon: "🌟", name: "星光" },
  { days: 60, icon: "🔥", name: "小火苗" },
  { days: 100, icon: "🏆", name: "小冠军" },
] as const;
// 分类图标用 lucide 而不是 ✎/⌂/✦ 这类字形：缺字体的系统会把它们画成空方块。
const taskSymbol = (category: string) =>
  category === "学习成长" ? (
    <BookOpen size={19} />
  ) : category === "家庭责任" ? (
    <Home size={19} />
  ) : (
    <Sparkles size={18} />
  );
// due_date 与提交日期都是家庭本地的日期字符串，所以「今天」也必须按家庭时区算：
// 拿设备的 UTC 日期去比，在 Asia/Shanghai 的 00:00–08:00 之间永远对不上。
// 日历算术只问「这一天是星期几 / 几月几日」，把它当本地零点解析与瞬时时区无关。
const familyToday = (timezone: string) =>
  familyDate(new Date().toISOString(), timezone);
const weekdayIndex = (date: string) => new Date(`${date}T00:00:00`).getDay();
const weekdayOf = (date: string) =>
  ["日", "一", "二", "三", "四", "五", "六"][weekdayIndex(date)];
const monthDayText = (date: string) =>
  `${date.slice(5, 7)}月${date.slice(8, 10)}日`;
const dateText = (date: string, today: string) =>
  date === today ? "今天" : monthDayText(date);

// favicon.svg 里同一个四角星。文字字形 ✦ 在不少系统字体里不存在，会渲染成空方块。


// The only way React catches a render error: without a boundary any screen that
// throws blanks the whole app, and the only recovery is a manual reload.
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("页面渲染出错", error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot-screen">
        <div className="boot-panel">
          <span className="brand-mark"><StarMark /></span>
          <h1>页面出了点问题</h1>
          <p>刷新一下就能回到成长空间。</p>
          <button
            className="wide-primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="*"
          element={
            <AppErrorBoundary>
              <Shell />
            </AppErrorBoundary>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

function Shell() {
  const store = useAppStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isParent = location.pathname.startsWith("/parent");
  const [showMenu, setShowMenu] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [parentGate, setParentGate] = useState<{ returnTo: string } | null>(
    null,
  );
  const parentUnlocked = store.state.role === "parent";
  const [rewardQueue, setRewardQueue] = useState<PointLedger[]>([]);
  const reward = rewardQueue[0] ?? null;
  // childId -> 本次页面加载里已经庆祝过的到账台账 id，同一笔到账不会弹第二次。
  const seenRewards = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    // store 启动时用的是 src/data.ts 的演示状态，必须等第一份服务端状态落地，
    // 才能判断哪些到账属于「打开页面前就已经存在」的历史记录。这条历史的边界
    // 现在由服务端的游标 children.rewardsSeenAt 给：谁先打开不再算谁看过。
    if (!store.connected) return;
    for (const child of store.state.children)
      if (!seenRewards.current.has(child.id))
        seenRewards.current.set(
          child.id,
          new Set(
            store.state.ledger
              .filter(
                (item) =>
                  item.childId === child.id &&
                  item.type === "earned" &&
                  item.createdAt <= child.rewardsSeenAt,
              )
              .map((item) => item.id),
          ),
        );
    // 家长端不庆祝：这些到账保持「未读」，等孩子端一打开就逐条弹出来。
    if (isParent) return;
    const childId = store.state.activeChildId;
    const seen = seenRewards.current.get(childId) ?? new Set<string>();
    seenRewards.current.set(childId, seen);
    const pending = store.state.ledger.filter(
      (item) =>
        item.childId === childId && item.type === "earned" && !seen.has(item.id),
    );
    if (!pending.length) return;
    setRewardQueue((queue) => {
      const queued = new Set(queue.map((item) => item.id));
      const fresh = pending.filter((item) => !queued.has(item.id));
      return fresh.length ? [...queue, ...fresh] : queue;
    });
  }, [isParent, store.connected, store.state]);
  useEffect(() => {
    if (isParent) setRewardQueue([]);
  }, [isParent]);
  // 队列走完 = 这一批孩子真的看过了：推进服务端的到账游标，刷新、重进、换设备都
  // 不再重弹。家长端（上面已经清空队列）和预览都不推进——预览看到的那批要留给孩子
  // 自己打开时看，这正是这个游标存在的理由。
  const unackedDrain = useRef(false);
  useEffect(() => {
    if (rewardQueue.length) {
      unackedDrain.current = true;
      return;
    }
    if (!unackedDrain.current) return;
    unackedDrain.current = false;
    if (isParent || store.preview) return;
    store.actions.markRewardsSeen();
  }, [rewardQueue.length, isParent, store.preview]);
  const dismissReward = () => {
    if (reward) {
      const seen = seenRewards.current.get(reward.childId) ?? new Set<string>();
      seen.add(reward.id);
      seenRewards.current.set(reward.childId, seen);
    }
    setRewardQueue((queue) => queue.slice(1));
  };
  useEffect(() => {
    if (!reward) return;
    const timer = window.setTimeout(dismissReward, 3600);
    return () => window.clearTimeout(timer);
  }, [reward?.id]);
  // 升级庆祝：baseline 语义与上面的到账队列一致——第一次服务端状态只记基线，
  // 家长端不弹（升级保持「未读」，等下一次打开孩子端）。一次 /state 跨多级时
  // 只显示最终那一级；等级回退（取消作业完成）静默。
  const levelBaselined = useRef(new Map<string, number>());
  const [levelUpLevel, setLevelUpLevel] = useState<number | null>(null);
  useEffect(() => {
    if (!store.connected) return;
    if (isParent) {
      setLevelUpLevel(null);
      return;
    }
    const child = store.activeChild;
    const baseline = levelBaselined.current.get(child.id);
    if (baseline === undefined) {
      levelBaselined.current.set(child.id, child.level);
      return;
    }
    if (child.level <= baseline) return;
    levelBaselined.current.set(child.id, child.level);
    setLevelUpLevel(child.level);
  }, [isParent, store.connected, store.state]);
  // 3.6 s 自动消失，与「已刷新」提示同一套约定；pointer-events:none，没有关闭按钮。
  useEffect(() => {
    if (levelUpLevel === null) return;
    const timer = window.setTimeout(() => setLevelUpLevel(null), 3600);
    return () => window.clearTimeout(timer);
  }, [levelUpLevel]);
  useEffect(() => {
    // The parent end is never restored by the session: a parent path always
    // costs the password, so a device left with a child cannot wander in.
    if (store.ready && isParent && !parentUnlocked && !parentGate) {
      setParentGate({ returnTo: location.pathname });
      navigate("/child", { replace: true });
    }
  }, [
    store.ready,
    isParent,
    parentUnlocked,
    parentGate,
    location.pathname,
    navigate,
  ]);
  const goRole = (role: "child" | "parent") => {
    setShowMenu(false);
    if (role === "parent") {
      setParentGate({ returnTo: "/parent" });
      return;
    }
    setParentGate(null);
    navigate("/child");
    store.actions.enterChild();
  };
  const unlockParent = async (password: string) => {
    if (!(await store.actions.unlockParent(password))) return false;
    const returnTo = parentGate?.returnTo ?? "/parent";
    setParentGate(null);
    navigate(returnTo);
    return true;
  };
  if (!store.ready)
    return (
      <div className="boot-screen">
        <p>正在连接成长空间...</p>
      </div>
    );
  if (!store.connected)
    return (
      <main className="boot-screen">
        <div className="boot-panel">
          <span className="brand-mark"><StarMark /></span>
          <h1>无法进入成长空间</h1>
          <p>{store.message || "请确认服务已经启动。"}</p>
          <button
            className="wide-primary"
            onClick={() => void store.actions.reconnect()}
          >
            重试
          </button>
        </div>
      </main>
    );
  return (
    <div className={`app-shell ${isParent ? "parent-shell" : "child-shell"}`}>
      <header className="topbar">
        <Link to={isParent ? "/parent" : "/child"} className="brand">
          <span className="brand-mark"><StarMark /></span>
          <span>小小成长家</span>
        </Link>
        <div className="top-actions">
          <button
            className="icon-button refresh-button"
            aria-label="刷新"
            title="刷新"
            onClick={() => store.actions.refresh()}
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-button menu-button"
            aria-label="打开菜单"
            onClick={() => setShowMenu((v) => !v)}
          >
            <Menu size={20} />
          </button>
          <button
            className="profile-button"
            onClick={() => setShowMenu((v) => !v)}
          >
            <span className="profile-avatar">{store.activeChild.avatar}</span>
            <span>{isParent ? "家长模式" : store.activeChild.name}</span>
            <ChevronRight size={16} />
          </button>
        </div>
        {showMenu && (
          <div className="role-menu">
            <p className="menu-kicker">选择孩子</p>
            {store.state.children.map((child) => (
              <button
                key={child.id}
                onClick={() => {
                  store.actions.setActiveChild(child.id);
                  setShowMenu(false);
                }}
                className={child.id === store.activeChild.id ? "selected" : ""}
              >
                <span className="menu-avatar">{child.avatar}</span>
                {child.name}
                <span>{child.pointsBalance} 积分</span>
              </button>
            ))}
            <p className="menu-kicker menu-divider">切换视角</p>
            <button
              onClick={() => goRole("child")}
              className={isParent ? "" : "selected"}
            >
              🌻 孩子端 <span>陪伴成长</span>
            </button>
            <button
              onClick={() => goRole("parent")}
              className={isParent ? "selected" : ""}
            >
              ☕ 家长端 <span>管理与鼓励</span>
            </button>
            {isParent && parentUnlocked && (
              <>
                <p className="menu-kicker menu-divider">家长设置</p>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setShowPassword(true);
                  }}
                >
                  🔑 修改家长密码 <span>需验证</span>
                </button>
              </>
            )}
          </div>
        )}
      </header>
      {parentGate && (
        <ParentPinModal
          onClose={() => setParentGate(null)}
          onConfirm={unlockParent}
        />
      )}
      {isParent && parentUnlocked && showPassword && (
        <ParentPasswordModal
          onClose={() => setShowPassword(false)}
          onChange={async (current, next) => {
            const ok = await store.actions.changeParentPassword(current, next);
            if (ok) setShowPassword(false);
            return ok;
          }}
        />
      )}
      {store.message && (
        <div
          className={store.messageOk ? "app-toast ok" : "app-toast"}
          role={store.messageOk ? "status" : "alert"}
        >
          <span>{store.message}</span>
          <button onClick={store.dismissMessage} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
      {reward && (
        <RewardCelebration
          key={reward.id}
          reward={reward}
          onClose={dismissReward}
        />
      )}
      {levelUpLevel !== null && (
        <LevelUpToast level={levelUpLevel} experience={store.activeChild.experience} />
      )}
      {isParent && parentUnlocked ? (
        <ParentLayout store={store} />
      ) : (
        <ChildLayout store={store} />
      )}
    </div>
  );
}

function ParentPinModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (password: string) => Promise<boolean>;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <form
        className={`modal pin-modal ${error ? "pin-error" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-pin-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!(await onConfirm(pin))) {
            setError(true);
            setPin("");
          }
        }}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="关闭密码验证"
        >
          <X size={18} />
        </button>
        <div className="pin-icon">
          <KeyRound size={27} />
        </div>
        <h2 id="parent-pin-title">进入家长端</h2>
        <p>请输入家长密码，孩子无法直接进入管理页面。</p>
        <label htmlFor="parent-pin">家长密码</label>
        <input
          id="parent-pin"
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          value={pin}
          onChange={(event) => {
            setPin(event.target.value);
            setError(false);
          }}
          aria-invalid={error}
        />
        {error && (
          <small className="pin-error-text">密码不正确，请重新输入</small>
        )}
        <button
          className="wide-primary"
          type="submit"
          disabled={pin.length < 4}
        >
          验证并进入
        </button>
      </form>
    </div>
  );
}

function ParentPasswordModal({
  onClose,
  onChange,
}: {
  onClose: () => void;
  onChange: (current: string, next: string) => Promise<boolean>;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <form
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-password-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (next !== repeat) {
            setError("两次输入的新密码不一致");
            return;
          }
          if (!(await onChange(current, next))) {
            setError("当前密码不正确，请重新输入");
            setCurrent("");
          }
        }}
      >
        <div className="form-heading">
          <div>
            <h2 id="parent-password-title">修改家长密码</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭修改密码">
            <X size={18} />
          </button>
        </div>
        <label>
          当前密码
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => {
              setCurrent(event.target.value);
              setError("");
            }}
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            autoComplete="new-password"
            value={next}
            onChange={(event) => {
              setNext(event.target.value.replace(/\D/g, ""));
              setError("");
            }}
          />
        </label>
        <label>
          确认新密码
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => {
              setRepeat(event.target.value.replace(/\D/g, ""));
              setError("");
            }}
          />
        </label>
        <small className="pin-hint">新密码为 4 位数字，例如 1357</small>
        {error && <small className="pin-error-text">{error}</small>}
        <button
          className="wide-primary"
          type="submit"
          disabled={
            current.length < 4 || next.length !== 4 || repeat.length !== 4
          }
        >
          保存新密码
        </button>
      </form>
    </div>
  );
}

function RewardCelebration({
  reward,
  onClose,
}: {
  reward: PointLedger;
  onClose: () => void;
}) {
  return (
    <div className="reward-celebration" role="status" aria-live="polite">
      <div className="reward-confetti" aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => (
          <i key={index} />
        ))}
      </div>
      <div className="reward-medal">
        <Sparkles size={25} />
      </div>
      <div>
        <span>{rewardTitles[reward.referenceType] ?? "任务确认完成"}</span>
        <strong>+{reward.amount} 积分到账！</strong>
        <small>{reward.description}</small>
      </div>
      <button onClick={onClose} aria-label="关闭积分到账提示">
        <X size={17} />
      </button>
    </div>
  );
}

// 升级提示：独立类名 + pointer-events:none + 3.6 s 自动消失，刻意不复用
// .reward-celebration——到账横幅是逐条要点关闭的队列，升级是右下角自己走掉的
// toast，两条样式规则与门禁断言（同屏只有一条 .reward-celebration）互不污染。
function LevelUpToast({ level, experience }: { level: number; experience: number }) {
  return (
    <div className="level-up" role="status" aria-live="polite">
      <span className="level-up-medal">
        <Sparkles size={20} />
      </span>
      <div>
        <span>成长等级提升</span>
        <strong>升到 Lv.{level}</strong>
        <small>成长能量 {experience}/100</small>
      </div>
    </div>
  );
}

function ChildLayout({ store }: { store: ReturnType<typeof useAppStore> }) {
  return (
    <>
      <main className="main-content">
        <Routes>
          <Route path="/child" element={<ChildHome store={store} />} />
          <Route path="/child/tasks" element={<ChildTasks store={store} />} />
          <Route path="/child/homework" element={<ChildHomework store={store} />} />
          <Route path="/child/wishes" element={<ChildWishes store={store} />} />
          <Route path="/child/ledger" element={<ChildLedger store={store} />} />
          <Route path="/child/growth" element={<Growth store={store} />} />
          <Route path="/child/games" element={<ChildGames store={store} />} />
          <Route path="/child/games/klotski" element={<KlotskiGame store={store} />} />
          <Route path="/child/games/calc" element={<CalcSprint store={store} />} />
          <Route path="/child/games/pattern" element={<PatternQuiz store={store} />} />
          <Route path="*" element={<Navigate to="/child" replace />} />
        </Routes>
      </main>
      <ChildNav />
    </>
  );
}
function ChildNav() {
  const location = useLocation();
  return (
    <nav className="bottom-nav">
      <Link
        className={location.pathname === "/child" ? "active" : ""}
        to="/child"
      >
        <Home size={20} />
        <span>今日</span>
      </Link>
      <Link
        className={location.pathname.includes("tasks") ? "active" : ""}
        to="/child/tasks"
      >
        <ListChecks size={20} />
        <span>任务</span>
      </Link>
      <Link
        className={location.pathname.includes("homework") ? "active" : ""}
        to="/child/homework"
      >
        <BookOpen size={20} />
        <span>作业</span>
      </Link>
      <Link
        className={location.pathname.includes("wishes") ? "active" : ""}
        to="/child/wishes"
      >
        <Gift size={20} />
        <span>愿望</span>
      </Link>
      <Link
        className={location.pathname.includes("growth") ? "active" : ""}
        to="/child/growth"
      >
        <Trophy size={20} />
        <span>成长</span>
      </Link>
    </nav>
  );
}

function ChildHome({ store }: { store: ReturnType<typeof useAppStore> }) {
  const { activeChild: child, childTasks: tasks } = store;
  const today = familyToday(store.state.timezone);
  const done = tasks.filter((t) => t.status === "completed").length;
  const pending = tasks.filter((t) => t.status === "pending_review").length;
  return (
    <div className="content-wrap">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">
            星期{weekdayOf(today)} · {monthDayText(today)}{" "}
            <LunarTag date={today} state={store.state} />
          </p>
          <h1>
            嗨，{child.name} <span className="wave"><StarMark size={22} /></span>
          </h1>
          <p className="muted">今天也一起收集小小成就吧</p>
        </div>
        <div className="streak">
          <span>🔥</span>
          <strong>{child.streakDays}</strong>
          <small>天连续</small>
        </div>
      </div>
      <TodayHomework store={store} />
      <SectionTitle title="今天要做什么" action="查看全部" to="/child/tasks" />
      <div className="task-list">
        {tasks.slice(0, 3).map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            today={today}
            timezone={store.state.timezone}
            submission={store.latestSubmissions.get(task.id)}
            onSubmit={store.actions.submitTask}
          />
        ))}
      </div>
      {pending > 0 && (
        <div className="notice-card">
          <Sparkles size={18} />
          <div>
            <strong>有 {pending} 个任务正在等待确认</strong>
            <span>完成得很棒，等家长来看看吧</span>
          </div>
          <Link to="/child/tasks">查看</Link>
        </div>
      )}
      <section
        className="companion-banner"
        style={{ "--companion": child.color } as React.CSSProperties}
      >
        <div className="sun-dots" aria-hidden="true"><StarMark size={23} /></div>
        <div className="companion-copy">
          <span className="pill light-pill">成长伙伴 · Lv.{child.level}</span>
          <h2>
            你正在变得
            <br />
            <em>越来越厉害！</em>
          </h2>
          <div className="level-line">
            <span style={{ width: `${child.experience}%` }} />
          </div>
          <small>{child.experience}/100 成长能量</small>
        </div>
        <div className="companion">{child.avatar}</div>
      </section>
      <section className="balance-row">
        <div className="balance-card">
          <div className="balance-icon">
            <Coins size={20} />
          </div>
          <div>
            <span>我的积分</span>
            <strong>{child.pointsBalance}</strong>
            <Link className="balance-link" to="/child/ledger">
              积分明细 <ChevronRight size={12} />
            </Link>
          </div>
          <Link to="/child/wishes">
            去兑换 <ChevronRight size={15} />
          </Link>
        </div>
        <div className="mini-stat">
          <span className="mini-stat-icon">✓</span>
          <strong>
            {done}
            <small>/ {tasks.length}</small>
          </strong>
          <span>今日完成</span>
        </div>
      </section>
      <GameTeaser store={store} />
      <SectionTitle title="愿望小铺" action="全部愿望" to="/child/wishes" />
      <div className="wish-strip">
        {/* 家长下架的愿望不该再出现在孩子的首页橱窗里（/child/wishes 也过滤了）。 */}
        {store.state.wishes
          .filter((wish) => wish.isActive)
          .slice(0, 3)
          .map((wish) => (
            <WishMini key={wish.id} wish={wish} balance={child.pointsBalance} />
          ))}
      </div>
    </div>
  );
}

// 家长端的确认/退回。退回一定要写一句话：review_note 是孩子唯一能看到「为什么被退回」
// 的通道（服务端收 30 字，随每条 submission 进 /state），空话不如不退回，所以空输入
// 时确认按钮是禁用的。两处（任务卡、任务管理行）共用，两端的退回口径不会走偏。
function ReviewActions({
  taskId,
  approveLabel = "确认",
  onReview,
}: {
  taskId: string;
  approveLabel?: string;
  onReview?: (id: string, approved: boolean, note?: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  if (!rejecting)
    return (
      <div className="review-actions">
        <button className="approve" onClick={() => onReview?.(taskId, true)}>
          {approveLabel}
        </button>
        <button className="reject" onClick={() => setRejecting(true)}>
          退回
        </button>
      </div>
    );
  const cancel = () => {
    setRejecting(false);
    setNote("");
  };
  return (
    <div className="review-actions rejecting">
      <input
        className="review-note"
        aria-label="退回原因"
        maxLength={30}
        autoFocus
        placeholder="告诉孩子要改哪里（30 字内）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="reject"
        disabled={!note.trim()}
        onClick={() => {
          onReview?.(taskId, false, note.trim());
          cancel();
        }}
      >
        确认退回
      </button>
      <button className="reject" onClick={cancel}>
        取消退回
      </button>
    </div>
  );
}

function TaskCard({
  task,
  today,
  timezone,
  submission,
  onSubmit,
  parent = false,
  onReview,
}: {
  task: Task;
  today: string;
  timezone: string;
  submission?: TaskSubmission;
  onSubmit?: (id: string) => unknown;
  parent?: boolean;
  onReview?: (id: string, approved: boolean, note?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    await onSubmit?.(task.id);
    setBusy(false);
  };
  return (
    <article className={`task-card ${task.status}`}>
      <div className={`task-symbol cat-${task.category}`}>
        {taskSymbol(task.category)}
      </div>
      <div className="task-main">
        <div className="task-top">
          <span className="task-category">{task.category}</span>
          <span className={`status-dot status-${task.status}`}>
            {statusLabel[task.status]}
          </span>
        </div>
        <h3>{task.title}</h3>
        <p>{task.description}</p>
        <div className="task-footer">
          <span className="points">
            <Coins size={14} /> +{task.points}
          </span>
          <span className="due">{dateText(task.dueDate, today)}</span>
          {task.status === "todo" && !parent && (
            <button
              className="small-primary"
              disabled={busy}
              onClick={submit}
            >
              完成任务
            </button>
          )}
          {task.status === "pending_review" && parent && (
            <ReviewActions
              taskId={task.id}
              approveLabel="确认完成"
              onReview={onReview}
            />
          )}
          {task.status === "rejected" && !parent && (
            <button
              className="small-primary"
              disabled={busy}
              onClick={submit}
            >
              重新提交
            </button>
          )}
        </div>
        {submission && (
          <SubmissionEvidence
            submission={submission}
            timezone={timezone}
            variant="card"
            title={parent ? "孩子提交" : "我提交的内容"}
          />
        )}
      </div>
    </article>
  );
}

function ChildTasks({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [filter, setFilter] = useState("全部");
  const tasks = store.childTasks.filter(
    (t) => filter === "全部" || t.category === filter,
  );
  return (
    <div className="content-wrap">
      <PageHeading
        title="我的任务"
        description="每完成一件小事，离愿望就更近一步。"
      />
      <div className="filter-row">
        {categories.map((c) => (
          <button
            key={c}
            className={filter === c ? "active" : ""}
            onClick={() => setFilter(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="task-list full-list">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            today={familyToday(store.state.timezone)}
            timezone={store.state.timezone}
            submission={store.latestSubmissions.get(t.id)}
            onSubmit={store.actions.submitTask}
          />
        ))}
      </div>
      {tasks.length === 0 && (
        <EmptyState
          icon={<StarMark size={22} />}
          title="这里还没有任务"
          text="去找家长安排一个吧"
        />
      )}
    </div>
  );
}
function StarRow({
  redemption,
  ownerName,
  timezone,
  onToggle,
}: {
  redemption: Redemption;
  ownerName?: string;
  timezone: string;
  onToggle?: (
    id: string,
    completed: boolean,
    note: string,
    attachments: Attachment[],
  ) => Promise<boolean>;
}) {
  const done = Boolean(redemption.completedAt);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const pick = (type: "image" | "video", files: FileList | null) => {
    const selected = Array.from(files ?? []).map((file) => ({
      name: file.name,
      type,
      file,
    }));
    setAttachments((current) => [
      ...current.filter((item) => item.type !== type),
      ...selected,
    ]);
  };
  return (
    <div className={`star-row ${done ? "star-done" : ""}`}>
      <div className="star-line">
        <span className="star-icon" style={{ background: redemption.wishColor }}>
          {redemption.wishIcon}
        </span>
        <div className="star-body">
          <strong>{redemption.wishTitle}</strong>
          <small>
            {ownerName ? `${ownerName} · ` : ""}
            {redemption.pointsCost} 积分 ·{" "}
            {dateText(
              familyDate(redemption.createdAt, timezone),
              familyToday(timezone),
            )}
          </small>
        </div>
        <span
          className={`status-chip ${done ? "status-completed" : "status-todo"}`}
        >
          {done ? "已完成" : "未完成"}
        </span>
        {onToggle &&
          (done ? (
            <button
              className="small-primary star-action"
              onClick={() => setUndoing(true)}
            >
              撤销完成
            </button>
          ) : (
            <button
              className="small-primary star-action"
              onClick={() => setOpen((current) => !current)}
            >
              标记完成
            </button>
          ))}
      </div>
      {(redemption.completedNote || redemption.attachments.length > 0) && (
        <div className="star-evidence">
          {redemption.completedNote && (
            <p className="submission-note">
              <MessageSquare size={15} />
              <span>{redemption.completedNote}</span>
            </p>
          )}
          <MediaGallery attachments={redemption.attachments} />
        </div>
      )}
      {open && onToggle && (
        <div className="star-complete">
          <textarea
            value={note}
            maxLength={30}
            onChange={(event) => setNote(event.target.value)}
            placeholder="写一句话记录这一刻吧（可选，30 字以内）"
          />
          <div className="attachment-row">
            <label>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => pick("image", event.target.files)}
              />
              <span>＋ 添加照片</span>
            </label>
            <label>
              <input
                type="file"
                accept="video/*"
                multiple
                onChange={(event) => pick("video", event.target.files)}
              />
              <span>＋ 添加视频</span>
            </label>
          </div>
          {attachments.length > 0 && (
            <div className="attachment-name">
              {attachments.map((item, index) => (
                <small key={`${item.name}-${index}`}>✓ {item.name}</small>
              ))}
            </div>
          )}
          <button
            className="wide-primary"
            disabled={saving}
            onClick={async () => {
              if (saving) return;
              setSaving(true);
              try {
                // 失败时（含网络错误）面板与已填的备注、照片都留着，别让人白写一遍。
                if (await onToggle(redemption.id, true, note, attachments)) {
                  setOpen(false);
                  setNote("");
                  setAttachments([]);
                }
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "提交中…" : "确认完成"}
          </button>
        </div>
      )}
      {undoing && (
        <ConfirmModal
          title="撤销这次完成？"
          text="撤销后，你写的备注和照片也会一起移除，可以重新标记完成。"
          confirm="确认撤销"
          onClose={() => setUndoing(false)}
          onConfirm={() => {
            setUndoing(false);
            void onToggle?.(redemption.id, false, "", []);
          }}
        />
      )}
    </div>
  );
}
function StarWishList({
  items,
  timezone,
  onToggle,
}: {
  items: { redemption: Redemption; ownerName?: string }[];
  timezone: string;
  onToggle?: (
    id: string,
    completed: boolean,
    note: string,
    attachments: Attachment[],
  ) => Promise<boolean>;
}) {
  if (items.length === 0)
    return (
      <EmptyState
        icon={<StarMark size={22} />}
        title="星愿清单还是空的"
        text={onToggle ? "去愿望小铺兑换第一个心愿吧" : "孩子还没有兑换过心愿"}
      />
    );
  return (
    <div className="star-list">
      {items.map(({ redemption, ownerName }) => (
        <StarRow
          key={redemption.id}
          redemption={redemption}
          ownerName={ownerName}
          timezone={timezone}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
function ChildWishes({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [selected, setSelected] = useState<Wish | null>(null);
  return (
    <div className="content-wrap">
      <PageHeading
        title="愿望小铺"
        description="用努力换来真正想要的东西。"
      />
      <div className="wish-balance">
        <div className="balance-icon">
          <Coins size={21} />
        </div>
        <div>
          <span>可以使用的积分</span>
          <strong>{store.activeChild.pointsBalance}</strong>
        </div>
        <span className="wish-balance-tip">再坚持一点点 ✨</span>
      </div>
      <div className="wish-grid">
        {store.state.wishes
          .filter((w) => w.isActive)
          .map((wish) => (
            <WishCard
              key={wish.id}
              wish={wish}
              balance={store.activeChild.pointsBalance}
              onRedeem={() => setSelected(wish)}
            />
          ))}
      </div>
      <div className="section-title">
        <h2>我的星愿清单</h2>
        {store.childRedemptions.length > 0 && (
          <span>
            {store.childRedemptions.filter((item) => item.completedAt).length}/
            {store.childRedemptions.length} 已实现
          </span>
        )}
      </div>
      <StarWishList
        items={store.childRedemptions.map((redemption) => ({ redemption }))}
        timezone={store.state.timezone}
        onToggle={store.actions.toggleRedemption}
      />
      {selected && (
        <ConfirmModal
          title={`兑换「${selected.title}」？`}
          text={`会使用 ${selected.pointsCost} 积分，兑换后就可以和家人一起实现啦。`}
          confirm="确认兑换"
          onClose={() => setSelected(null)}
          onConfirm={() => {
            store.actions.redeemWish(selected);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}



// 作业卡片 + 全屏灯箱：孩子端首页的「今日作业」模块与 /child/homework 共用同一份实现，
// 灯箱顺序是页面内全部媒体（先摊平再按下标定位）。





function WishMini({ wish, balance }: { wish: Wish; balance: number }) {
  return (
    <Link
      to="/child/wishes"
      className="wish-mini"
      style={{ "--wish": wish.color } as React.CSSProperties}
    >
      <span>{wish.icon}</span>
      <strong>{wish.title}</strong>
      <small>
        <Coins size={12} /> {wish.pointsCost} ·{" "}
        {balance >= wish.pointsCost ? "可兑换" : `还差 ${wish.pointsCost - balance}`}
      </small>
    </Link>
  );
}
function WishCard({
  wish,
  balance,
  onRedeem,
}: {
  wish: Wish;
  balance: number;
  onRedeem: () => void;
}) {
  const can = balance >= wish.pointsCost;
  // 差多少要看得见：进度条按余额/标价画比例，points_cost 有 CHECK(points_cost>0)，
  // 无除零；余额为负时进度与「已攒」都夹到 0，不画倒灌。
  const saved = Math.max(0, Math.min(balance, wish.pointsCost));
  const percent = Math.max(
    0,
    Math.min(100, Math.round((balance / wish.pointsCost) * 100)),
  );
  return (
    <article className="wish-card">
      <div className="wish-art" style={{ background: wish.color }}>
        {wish.icon}
      </div>
      <div className="wish-card-body">
        <div>
          <h3>{wish.title}</h3>
          <p>{wish.description}</p>
        </div>
        <div>
          <div
            className="wish-progress"
            role="img"
            aria-label={`已攒 ${saved}/${wish.pointsCost} 积分`}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <small className="wish-progress-label">
            {can ? "积分够了，去兑换吧" : `已攒 ${saved}/${wish.pointsCost}`}
          </small>
        </div>
        <div className="wish-card-foot">
          <span className="cost">
            <Coins size={14} />
            {wish.pointsCost}
          </span>
          <button
            className={can ? "small-primary" : "small-disabled"}
            disabled={!can}
            onClick={onRedeem}
          >
            {can ? "去兑换" : `还差 ${wish.pointsCost - balance}`}
          </button>
        </div>
      </div>
    </article>
  );
}

function Growth({ store }: { store: ReturnType<typeof useAppStore> }) {
  const { activeChild: child, state } = store;
  // 两个指标必须同一个口径：childTasks 只有「今天还要处理」的实例，用它数完成数、
  // 却用全量账本求和，就会得到「完成 3 个任务、获得 320 积分」。历史全在 state.tasks 里。
  const done = state.tasks.filter(
    (task) => task.childId === child.id && task.status === "completed",
  ).length;
  const earned = state.ledger
    .filter((item) => item.childId === child.id && item.type === "earned")
    .reduce((sum, item) => sum + item.amount, 0);
  const today = familyDate(new Date().toISOString(), state.timezone);
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const activity = useMemo(() => dayActivity(state, child.id), [state, child.id]);
  const digest = useMemo(
    () => dayDigest(state, child.id, selected),
    [state, child.id, selected],
  );
  // 日历算术只问「某年某月的一号是星期几 / 这个月有几天」，与瞬时无关。
  const [year, monthNumber] = month.split("-").map(Number);
  const lead = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const total = new Date(year, monthNumber, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, (): string | null => null),
    ...Array.from(
      { length: total },
      (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
    ),
  ];
  // 星期必须按「面板正在讲的那一天」算：selected 才是那一行标题的来源，month 只是
  // 日历翻到哪一页。用 month + selectedDay 拼日期，翻了月还没点格子就会配错。
  const [selectedMonth, selectedDay] = selected
    .split("-")
    .slice(1)
    .map(Number);
  const weekday = weekdayOf(selected);
  const counts: Record<Task["status"], number> = {
    todo: 0,
    pending_review: 0,
    completed: 0,
    rejected: 0,
  };
  for (const entry of digest.scheduled) counts[entry.task.status] += 1;
  const shiftMonth = (delta: number) => {
    const next = new Date(year, monthNumber - 1 + delta, 1);
    setMonth(
      `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`,
    );
  };
  return (
    <div className="content-wrap">
      <PageHeading
        title="成长足迹"
        description="每一个小小坚持，都值得被看见。"
      />
      <div className="growth-hero">
        <div className="growth-figure">{store.activeChild.avatar}</div>
        <div>
          <span className="pill">Lv.{store.activeChild.level} 小小行动家</span>
          <h2>本周也有在发光 ✨</h2>
          <div className="level-line">
            <span style={{ width: `${store.activeChild.experience}%` }} />
          </div>
          <small>{100 - store.activeChild.experience} 点能量升级</small>
        </div>
      </div>
      <div className="metric-grid">
        <Metric icon="✓" value={String(done)} label="完成任务" color="mint" />
        <Metric
          icon="+"
          value={String(earned)}
          label="获得积分"
          color="peach"
        />
        <Metric
          icon="🔥"
          value={String(store.activeChild.streakDays)}
          label="连续天数"
          color="yellow"
        />
      </div>
      <section className="chart-panel growth-calendar">
        <div className="panel-heading">
          <div>
            <h2>成长日历</h2>
          </div>
          <div className="calendar-nav">
            <button aria-label="上一个月" onClick={() => shiftMonth(-1)}>
              ‹
            </button>
            <span className="calendar-month">
              {year} 年 {monthNumber} 月
            </span>
            <button
              aria-label="下一个月"
              disabled={month === today.slice(0, 7)}
              onClick={() => shiftMonth(1)}
            >
              ›
            </button>
          </div>
        </div>
        <CalendarGrid
          cells={cells}
          selected={selected}
          today={today}
          activity={activity}
          onSelect={setSelected}
          holidays={store.state.holidays}
          makeupWorkdays={store.state.makeupWorkdays}
        />
      </section>
      <section className="chart-panel day-panel">
        <div className="panel-heading">
          <div>
            <h2>
              {selected === today ? "今天" : `${selectedMonth}月${selectedDay}日`}{" "}
              · 周{weekday}
            </h2>
            <LunarTag date={selected} state={store.state} />
          </div>
          <span className="chart-total">
            {digest.scheduled.length} <small>个任务</small>
          </span>
        </div>
        <div className="day-summary">
          <span>已完成 {counts.completed}</span>
          <span>待确认 {counts.pending_review}</span>
          <span>待完成 {counts.todo}</span>
          {counts.rejected > 0 && <span>再试一次 {counts.rejected}</span>}
          {digest.backfilled.length > 0 && (
            <span>补录 {digest.backfilled.length}</span>
          )}
          <span>获得 {digest.earned} 积分</span>
        </div>
        {digest.scheduled.length === 0 && digest.backfilled.length === 0 ? (
          <EmptyState
            icon={<StarMark size={22} />}
            title="这一天没有任务记录"
            text="换一个日期看看吧"
          />
        ) : (
          <>
            <h3 className="day-group">当天的任务</h3>
            {digest.scheduled.length === 0 ? (
              <p className="empty-evidence">这一天没有安排任务</p>
            ) : (
              digest.scheduled.map((entry) => (
                <DayTaskRow
                  key={entry.task.id}
                  entry={entry}
                  today={today}
                  timezone={state.timezone}
                />
              ))
            )}
            {digest.backfilled.length > 0 && (
              <>
                <h3 className="day-group">补录记录</h3>
                {digest.backfilled.map((entry) => (
                  <DayTaskRow
                    key={entry.task.id}
                    entry={entry}
                    today={today}
                    timezone={state.timezone}
                    backfill
                  />
                ))}
              </>
            )}
          </>
        )}
      </section>
      <section className="achievement">
        <div className="achievement-badge">🌱</div>
        <div>
          <h3>连续坚持 {store.activeChild.streakDays} 天</h3>
          <p>
            {(() => {
              if (store.activeChild.streakDays === 0)
                return "今天完成一个任务，连续天数就开始累积。";
              const nextBadge = streakBadges.find(
                (badge) => store.activeChild.streakDays < badge.days,
              );
              if (!nextBadge)
                return "最高徽章已经点亮，连续天数还在往上涨。";
              return `再坚持 ${nextBadge.days - store.activeChild.streakDays} 天，解锁${nextBadge.icon}${nextBadge.name}徽章`;
            })()}
          </p>
        </div>
        <ChevronRight size={18} />
      </section>
      <div className="badge-row" role="list">
        {streakBadges.map((badge) => (
          <span
            key={badge.days}
            role="listitem"
            className={`badge-chip${store.activeChild.streakDays >= badge.days ? "" : " locked"}`}
            title={badge.name}
          >
            {badge.icon}
            <small>{badge.days}天</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function CalendarGrid({
  cells,
  selected,
  today,
  activity,
  onSelect,
  holidays,
  makeupWorkdays,
}: {
  cells: (string | null)[];
  selected: string;
  today: string;
  activity: Record<string, DayActivity>;
  onSelect: (date: string) => void;
  holidays: HolidaySpan[];
  makeupWorkdays: string[];
}) {
  return (
    <div className="calendar-grid">
      {["一", "二", "三", "四", "五", "六", "日"].map((label) => (
        <span className="calendar-weekday" key={label}>
          {label}
        </span>
      ))}
      {cells.map((date, index) => {
        if (!date)
          return <span className="calendar-empty" key={`empty-${index}`} />;
        const day = activity[date];
        const dot = day
          ? day.backfilled > 0
            ? "backfill"
            : day.scheduled > 0 && day.completed === day.scheduled
              ? "done"
              : "open"
          : "";
        const lunar = lunarLabel(date);
        const festival = lunarFestival(date);
        const mark = restMark(date, holidays, makeupWorkdays);
        return (
          <button
            className={`calendar-day${date === selected ? " selected" : ""}${date === today ? " today" : ""}`}
            aria-pressed={date === selected}
            aria-label={`${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日 农历${lunarMonthDay(date)}${festival ? ` ${festival}` : ""}${mark ? (mark === "休" ? " 放假" : " 上班") : ""}`}
            key={date}
            onClick={() => onSelect(date)}
          >
            <span className="calendar-day-num">{Number(date.slice(8, 10))}</span>
            <span className="calendar-lunar">{lunar}</span>
            {mark && (
              <span className={`calendar-mark ${mark === "休" ? "rest" : "work"}`}>
                {mark}
              </span>
            )}
            <span className={`calendar-dot${dot ? ` ${dot}` : ""}`} />
          </button>
        );
      })}
    </div>
  );
}

function DayTaskRow({
  entry,
  today,
  timezone,
  backfill = false,
}: {
  entry: DayEntry;
  today: string;
  timezone: string;
  backfill?: boolean;
}) {
  const { task, submission, submissionDate } = entry;
  return (
    <article className="day-task">
      <div className="day-task-line">
        <div className={`task-symbol cat-${task.category}`}>
          {taskSymbol(task.category)}
        </div>
        <div className="day-task-main">
          <h4>
            {task.title}
            {backfill ? (
              <span className="day-badge">
                原定 {dateText(task.dueDate, today)}
              </span>
            ) : (
              submissionDate !== undefined &&
              submissionDate !== task.dueDate && (
                <span className="day-badge">
                  补录 · {dateText(submissionDate, today)}提交
                </span>
              )
            )}
          </h4>
          <p>
            {task.category} · +{task.points}
          </p>
        </div>
        <span className={`status-dot status-${task.status}`}>
          {statusLabel[task.status]}
        </span>
      </div>
      {submission && (
        <SubmissionEvidence
          submission={submission}
          timezone={timezone}
          title="提交记录"
          variant="card"
        />
      )}
    </article>
  );
}

function ParentLayout({ store }: { store: ReturnType<typeof useAppStore> }) {
  // 待确认的数量必须在任何页面都能看到，否则家长得先点进任务管理才知道有活要干。
  // 口径与总览的「需要你的确认」一致：同一个当前孩子的 childTasks。
  const pendingReview = store.childTasks.filter(
    (task) => task.status === "pending_review",
  ).length;
  return (
    <div className="parent-layout">
      <aside className="sidebar">
        <div className="sidebar-label">FAMILY SPACE</div>
        <Link className="child-switcher" to="/parent/children">
          <span className="profile-avatar">{store.activeChild.avatar}</span>
          <div>
            <strong>{store.activeChild.name}</strong>
            <small>管理孩子档案</small>
          </div>
          <ChevronRight size={16} />
        </Link>
        <nav className="side-nav">
          <p>管理中心</p>
          <SideLink
            to="/parent"
            icon={<LayoutDashboard size={18} />}
            label="家庭总览"
            short="总览"
          />
          <SideLink
            to="/parent/children"
            icon={<Users size={18} />}
            label="孩子管理"
            short="孩子"
          />
          <SideLink
            to="/parent/tasks"
            icon={<ClipboardCheck size={18} />}
            label="任务管理"
            short="任务"
            badge={pendingReview}
          />
          <SideLink
            to="/parent/wishes"
            icon={<Gift size={18} />}
            label="愿望管理"
            short="愿望"
          />
          <SideLink
            to="/parent/homework"
            icon={<BookOpen size={18} />}
            label="作业管理"
            short="作业"
          />
          <SideLink
            to="/parent/games"
            icon={<Gamepad2 size={18} />}
            label="游戏进度"
            short="游戏"
          />
          <SideLink
            to="/parent/stats"
            icon={<BarChart3 size={18} />}
            label="成长统计"
            short="统计"
          />
        </nav>
        <div className="sidebar-bottom">
          <div className="tip-box">
            <Sparkles size={16} />
            <span>
              今天也记得
              <br />
              <strong>给孩子一点鼓励</strong>
            </span>
          </div>
          <Link
            className="text-button"
            to="/child"
            onClick={() => store.actions.enterChild()}
          >
            <Star size={16} /> 回到孩子端
          </Link>
        </div>
      </aside>
      <main className="parent-main">
        <Routes>
          <Route path="/parent" element={<ParentOverview store={store} />} />
          <Route
            path="/parent/children"
            element={<ParentChildren store={store} />}
          />
          <Route path="/parent/tasks" element={<ParentTasks store={store} />} />
          <Route
            path="/parent/wishes"
            element={<ParentWishes store={store} />}
          />
          <Route
            path="/parent/homework"
            element={<ParentHomework store={store} />}
          />
          <Route path="/parent/stats" element={<ParentStats store={store} />} />
          <Route path="/parent/games" element={<ParentGames store={store} />} />
          <Route path="*" element={<Navigate to="/parent" replace />} />
        </Routes>
      </main>
    </div>
  );
}
function SideLink({
  to,
  icon,
  label,
  short,
  badge = 0,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  short: string;
  badge?: number;
}) {
  const location = useLocation();
  return (
    <Link className={location.pathname === to ? "active" : ""} to={to}>
      {icon}
      <span className="nav-label">{label}</span>
      <span className="nav-short" aria-hidden="true">
        {short}
      </span>
      {badge > 0 && (
        <span className="nav-badge" title={`${badge} 项待确认`}>
          {badge}
        </span>
      )}
      <ChevronRight size={14} />
    </Link>
  );
}
function ParentOverview({ store }: { store: ReturnType<typeof useAppStore> }) {
  const tasks = store.childTasks;
  const pending = tasks.filter((t) => t.status === "pending_review");
  const done = store.stats.completedTasks;
  const total = store.stats.totalTasks;
  const [awarding, setAwarding] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  return (
    <div className="parent-content">
      <ParentHeader
        title="家庭总览"
        action={
          <span className="parent-header-actions">
            <button
              className="primary-button"
              onClick={() => setAwarding(true)}
            >
              <Coins size={16} /> 奖励积分
            </button>
            <Link
              className="outline-button"
              to="/child"
              onClick={() => store.actions.enterChild()}
            >
              <Sparkles size={16} /> 看看孩子端
            </Link>
          </span>
        }
      />
      <div className="parent-welcome">
        <div>
          <span className="pill light-pill">
            今天 · {monthDayText(familyToday(store.state.timezone))}
          </span>
          <h2>
            陪伴 {store.activeChild.name}
            <br />
            一起完成小目标。
          </h2>
          <p>每一次确认，都是对孩子努力的回应。</p>
        </div>
        <div className="parent-sun">☀️</div>
      </div>
      <div className="overview-metrics">
        <div>
          <span>待确认任务</span>
          <strong className={pending.length ? "accent-number" : ""}>
            {pending.length}
          </strong>
          <small>需要你的回应</small>
        </div>
        <div>
          <span>本周完成率</span>
          <strong>{Math.round((done / Math.max(total, 1)) * 100)}%</strong>
          <small>最近 7 天</small>
        </div>
        <div>
          <span>当前积分</span>
          <strong>{store.activeChild.pointsBalance}</strong>
          <small>孩子可兑换</small>
        </div>
      </div>
      <div className="parent-section-head">
        <h2>
          需要你的确认 <span>{pending.length}</span>
        </h2>
        <span className="section-actions">
          {pending.length > 1 && (
            <button
              className="outline-button"
              onClick={() => setConfirmAll(true)}
            >
              全部确认
            </button>
          )}
          <Link to="/parent/tasks">
            查看全部 <ChevronRight size={15} />
          </Link>
        </span>
      </div>
      {pending.length ? (
        <div className="review-list">
          {pending.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              today={familyToday(store.state.timezone)}
              timezone={store.state.timezone}
              submission={store.latestSubmissions.get(t.id)}
              parent
              onReview={store.actions.reviewTask}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="✓"
          title="全部确认完毕"
          text="今天暂时没有待处理的任务"
        />
      )}
      <div className="parent-section-head">
        <h2>最近动态</h2>
      </div>
      <div className="activity-list">
        {store.state.ledger
          .slice(-3)
          .reverse()
          .map((item) => (
            <div key={item.id}>
              <span
                className={
                  item.type === "earned"
                    ? "activity-icon earned"
                    : "activity-icon spent"
                }
              >
                {item.type === "earned" ? "+" : "−"}
              </span>
              <div>
                <strong>{item.description}</strong>
                <small>
                  {monthDayText(
                    familyDate(item.createdAt, store.state.timezone),
                  )}
                </small>
              </div>
              <b className={item.type === "earned" ? "positive" : "negative"}>
                {item.amount > 0 ? "+" : ""}
                {item.amount}
              </b>
            </div>
          ))}
      </div>
      {confirmAll && (
        <ConfirmModal
          title={`全部确认 ${pending.length} 项？`}
          text={`确认后这 ${pending.length} 项任务会一起加上积分，这一步不能撤销。`}
          confirm="确认全部"
          onClose={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            void store.actions.reviewAll(pending.map((task) => task.id));
          }}
        />
      )}
      {awarding && (
        <PointsForm
          child={store.activeChild}
          onClose={() => setAwarding(false)}
          onSubmit={async (amount, note) => {
            // 失败时把面板留着：金额和原因还在这里，改一下就能重试。
            if (
              await store.actions.awardPoints(store.activeChild.id, amount, note)
            )
              setAwarding(false);
          }}
        />
      )}
    </div>
  );
}

function ParentChildren({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [editing, setEditing] = useState<Child | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleting, setDeleting] = useState<Child | null>(null);
  const canDelete = store.state.children.length > 1;
  return (
    <div className="parent-content">
      <ParentHeader
        title="孩子管理"
        action={
          <button className="primary-button" onClick={() => setShowForm(true)}>
            <UserPlus size={17} /> 新增孩子
          </button>
        }
      />
      <p className="section-description">
        管理家庭中的孩子档案。任务、积分和成长记录会分别归属到对应孩子。
      </p>
      <div className="child-admin-grid">
        {store.state.children.map((child) => (
          <article
            className={`child-profile-card ${child.id === store.activeChild.id ? "active" : ""}`}
            key={child.id}
          >
            <div className="child-profile-head">
              <span
                className="child-profile-avatar"
                style={{ background: child.color }}
              >
                {child.avatar}
              </span>
              <div>
                <h2>{child.name}</h2>
                <span>
                  Lv.{child.level} · 连续 {child.streakDays} 天
                </span>
              </div>
              {child.id === store.activeChild.id && (
                <span className="current-child-chip">当前孩子</span>
              )}
            </div>
            <div className="child-profile-stats">
              <div>
                <strong>{child.pointsBalance}</strong>
                <span>可用积分</span>
              </div>
              <div>
                <strong>{Math.round(child.experience)}</strong>
                <span>成长能量</span>
              </div>
              <div>
                <strong>
                  {
                    store.state.tasks.filter(
                      (task) => task.childId === child.id,
                    ).length
                  }
                </strong>
                <span>任务数量</span>
              </div>
            </div>
            <div className="child-profile-actions">
              {child.id !== store.activeChild.id && (
                <button
                  className="outline-button"
                  onClick={() => store.actions.setActiveChild(child.id)}
                >
                  设为当前
                </button>
              )}
              <button
                className="icon-button"
                aria-label={`编辑${child.name}`}
                title="编辑孩子"
                onClick={() => setEditing(child)}
              >
                <Pencil size={16} />
              </button>
              <button
                className="icon-button danger-icon"
                aria-label={`删除${child.name}`}
                title={canDelete ? "删除孩子" : "至少保留一个孩子"}
                disabled={!canDelete}
                onClick={() => setDeleting(child)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {(showForm || editing) && (
        <ChildForm
          child={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSave={async (draft) => {
            // 校验失败（400）时保持表单打开，输入不会丢。
            if (await store.actions.saveChild(draft, editing?.id)) {
              setShowForm(false);
              setEditing(null);
            }
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`删除「${deleting.name}」？`}
          text="该孩子的任务、提交记录、积分流水和兑换记录会一并删除，此操作无法撤销。"
          confirm="确认删除"
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            store.actions.deleteChild(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function ChildForm({
  child,
  onClose,
  onSave,
}: {
  child: Child | null;
  onClose: () => void;
  onSave: (draft: Pick<Child, "name" | "avatar" | "color">) => Promise<unknown>;
}) {
  const avatars = ["🌻", "🚀", "🌈", "⭐", "🦕", "🐳"];
  const colors = [
    "#ffb547",
    "#55b8a4",
    "#ff8f78",
    "#9d8be8",
    "#67a9dc",
    "#7bc47f",
  ];
  const [name, setName] = useState(child?.name ?? "");
  const [avatar, setAvatar] = useState(child?.avatar ?? avatars[0]);
  const [color, setColor] = useState(child?.color ?? colors[0]);
  const [saving, setSaving] = useState(false);
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <form
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="child-form-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || saving) return;
          setSaving(true);
          try {
            await onSave({ name: name.trim(), avatar, color });
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="form-heading">
          <div>
            <h2 id="child-form-title">{child ? "编辑孩子档案" : "添加一个孩子"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭孩子表单">
            <X size={18} />
          </button>
        </div>
        <div className="child-preview" style={{ background: color }}>
          <span>{avatar}</span>
          <strong>{name || "孩子名字"}</strong>
        </div>
        <label>
          孩子姓名
          <input
            required
            autoFocus
            maxLength={12}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="请输入孩子姓名"
          />
        </label>
        <fieldset>
          <legend>选择头像</legend>
          <div className="avatar-options">
            {avatars.map((item) => (
              <button
                type="button"
                key={item}
                className={avatar === item ? "selected" : ""}
                onClick={() => setAvatar(item)}
                aria-label={`选择头像${item}`}
              >
                {item}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>主题颜色</legend>
          <div className="color-options">
            {colors.map((item) => (
              <button
                type="button"
                key={item}
                className={color === item ? "selected" : ""}
                style={{ background: item }}
                onClick={() => setColor(item)}
                aria-label={`选择颜色${item}`}
              />
            ))}
          </div>
        </fieldset>
        <button className="wide-primary" type="submit" disabled={saving}>
          {saving ? "保存中…" : child ? "保存修改" : "添加孩子"}
        </button>
      </form>
    </div>
  );
}

function PointsForm({
  child,
  onClose,
  onSubmit,
}: {
  child: Child;
  onClose: () => void;
  onSubmit: (amount: number, note: string) => Promise<unknown>;
}) {
  const presets = [5, 10, 20, 50];
  const [mode, setMode] = useState<"add" | "deduct">("add");
  const [amount, setAmount] = useState("10");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <form
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="points-form-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          const value = Number(amount);
          if (!Number.isInteger(value) || value < 1 || value > 500) {
            setError("请输入 1-500 之间的整数");
            return;
          }
          setSaving(true);
          try {
            await onSubmit(mode === "add" ? value : -value, note.trim());
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="form-heading">
          <div>
            <h2 id="points-form-title">给「{child.name}」调整积分</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭积分调整">
            <X size={18} />
          </button>
        </div>
        <div className="amount-options">
          {(["add", "deduct"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={mode === item ? "selected" : ""}
              aria-pressed={mode === item}
              onClick={() => {
                setMode(item);
                setError("");
              }}
            >
              {item === "add" ? "增加积分" : "扣除积分"}
            </button>
          ))}
        </div>
        <label>
          积分数量
          <input
            autoFocus
            required
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setError("");
            }}
          />
        </label>
        <div className="amount-options">
          {presets.map((item) => (
            <button
              type="button"
              key={item}
              className={Number(amount) === item ? "selected" : ""}
              onClick={() => {
                setAmount(String(item));
                setError("");
              }}
            >
              {item}
            </button>
          ))}
        </div>
        <label>
          原因（可选）
          <input
            maxLength={30}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="例如：主动帮妈妈拎菜"
          />
        </label>
        <small className="pin-hint">当前可用积分：{child.pointsBalance}</small>
        {error && <small className="pin-error-text">{error}</small>}
        <button className="wide-primary" type="submit" disabled={saving}>
          {saving ? "提交中…" : mode === "add" ? "确认奖励" : "确认扣除"}
        </button>
      </form>
    </div>
  );
}

function ParentTasks({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [filter, setFilter] = useState<
    "all" | "pending_review" | "todo" | "completed"
  >("all");
  const tasks = store.childTasks.filter(
    (task) => filter === "all" || task.status === filter,
  );
  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
  };
  return (
    <div className="parent-content">
      <ParentHeader
        title="任务管理"
        action={
          <button
            className="primary-button"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Plus size={17} /> 新建任务
          </button>
        }
      />
      <div className="admin-toolbar">
        <div className="filter-row">
          {[
            ["all", "全部"],
            ["pending_review", "待确认"],
            ["todo", "待完成"],
            ["completed", "已完成"],
          ].map(([id, label]) => (
            <button
              className={filter === id ? "active" : ""}
              onClick={() => setFilter(id as typeof filter)}
              key={id}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="toolbar-count">共 {tasks.length} 个任务</span>
      </div>
      <div className="admin-task-list">
        {tasks.map((task) => (
          <AdminTaskRow
            task={task}
            timezone={store.state.timezone}
            submission={store.latestSubmissions.get(task.id)}
            key={task.id}
            onReview={store.actions.reviewTask}
            onEdit={() => setEditing(task)}
            onDelete={() => setDeleting(task)}
          />
        ))}
      </div>
      {(showForm || editing) && (
        <TaskForm
          task={editing}
          timezone={store.state.timezone}
          onClose={closeForm}
          onSave={async (draft) => {
            if (
              await store.actions.saveTask(
                { ...draft, childId: store.state.activeChildId },
                editing?.id,
              )
            )
              closeForm();
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`删除「${deleting.title}」？`}
          text="任务及孩子对此任务的提交凭证会被删除，已经产生的积分记录会保留。"
          confirm="确认删除"
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            store.actions.deleteTask(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}
function MediaItem({
  attachment,
  onPreview,
}: {
  attachment: Attachment;
  onPreview: (attachment: Attachment) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (!attachment.url || failed)
    return (
      <span className="attachment-chip">
        {attachment.type === "image" ? (
          <ImageIcon size={15} />
        ) : (
          <Video size={15} />
        )}
        <span>{attachment.name}</span>
        <small>
          {failed ? "加载失败" : attachment.type === "image" ? "照片" : "视频"}
        </small>
      </span>
    );
  if (attachment.type === "video")
    return (
      <video
        className="media-video"
        src={attachment.url}
        controls
        preload="metadata"
        playsInline
      />
    );
  return (
    <button
      type="button"
      className="media-thumb"
      aria-label={`查看${attachment.name}`}
      onClick={() => onPreview(attachment)}
    >
      <img
        src={attachment.url}
        alt={attachment.name}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </button>
  );
}
// 预览层必须挂载时才建立 useDialog 的 ref：把 ref 留在 {preview && …} 里面，
// useDialog 在挂载时看到的是 null，直接 return，Esc 与焦点循环全都不会绑上。
function MediaPreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose} ref={dialog}>
      <figure
        className="media-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
        onClick={(event) => event.stopPropagation()}
      >
        <ZoomableImage src={attachment.url} alt={attachment.name} />
        <figcaption>{attachment.name}</figcaption>
      </figure>
      <button className="modal-close" onClick={onClose} aria-label="关闭预览">
        <X size={18} />
      </button>
    </div>
  );
}
function MediaGallery({ attachments }: { attachments: Attachment[] }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  return (
    <>
      <div className="media-grid">
        {attachments.map((attachment, index) => (
          <MediaItem
            key={`${attachment.name}-${index}`}
            attachment={attachment}
            onPreview={setPreview}
          />
        ))}
      </div>
      {preview && (
        <MediaPreview
          attachment={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
function SubmissionEvidence({
  submission,
  timezone,
  title = "孩子提交",
  variant = "row",
}: {
  submission: TaskSubmission;
  timezone: string;
  title?: string;
  variant?: "row" | "card";
}) {
  return (
    <div
      className={`submission-evidence${variant === "card" ? " card-evidence" : ""}`}
    >
      <div className="evidence-heading">
        <strong>{title}</strong>
        <time dateTime={submission.submittedAt}>
          {familyTime(submission.submittedAt, timezone)}
        </time>
      </div>
      {submission.reviewNote && (
        <p className="review-note-line">家长：{submission.reviewNote}</p>
      )}
      {(submission.note || submission.attachments.length > 0) && (
        <>
          {submission.note && (
            <p className="submission-note">
              <MessageSquare size={15} />
              <span>{submission.note}</span>
            </p>
          )}
          {submission.attachments.length > 0 && (
            <div className="attachment-list">
              <MediaGallery attachments={submission.attachments} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
function AdminTaskRow({
  task,
  timezone,
  submission,
  onReview,
  onEdit,
  onDelete,
}: {
  task: Task;
  timezone: string;
  submission?: TaskSubmission;
  onReview: (id: string, ok: boolean, note?: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="admin-task-item">
      <div className="admin-row">
        <div className={`task-symbol cat-${task.category}`}>
          {taskSymbol(task.category)}
        </div>
        <div className="admin-row-main">
          <div>
            <h3>{task.title}</h3>
            <p>
              {task.category} ·{" "}
              {task.repeatRule === "daily"
                ? "每天"
                : task.repeatRule === "weekly"
                  ? task.repeatWeekdays.length > 1
                    ? `每周 ${task.repeatWeekdays
                        .map((day) => weekdayShort[day])
                        .join("/")}`
                    : `每周${weekdayShort[task.repeatWeekday]}`
                  : "一次性"}
            </p>
          </div>
          <span className="points">
            <Coins size={14} /> +{task.points}
          </span>
        </div>
        <div className={`status-chip status-${task.status}`}>
          {statusLabel[task.status]}
        </div>
        {task.status === "pending_review" && (
          <ReviewActions taskId={task.id} onReview={onReview} />
        )}
        <button
          className="icon-button"
          onClick={onEdit}
          aria-label={`编辑${task.title}`}
          title="编辑任务"
        >
          <Pencil size={16} />
        </button>
        <button
          className="icon-button danger-icon"
          onClick={onDelete}
          aria-label={`删除${task.title}`}
          title="删除任务"
        >
          <Trash2 size={16} />
        </button>
      </div>
      {submission && (
        <SubmissionEvidence submission={submission} timezone={timezone} />
      )}
    </article>
  );
}
function TaskForm({
  task,
  timezone,
  onClose,
  onSave,
}: {
  task: Task | null;
  timezone: string;
  onClose: () => void;
  onSave: (draft: {
    title: string;
    description: string;
    category: string;
    points: number;
    repeatRule: RepeatRule;
    repeatWeekday: number;
    repeatWeekdays: number[];
  }) => Promise<unknown>;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [category, setCategory] = useState(task?.category ?? "生活自理");
  const [points, setPoints] = useState(task?.points ?? 20);
  const [repeatRule, setRepeatRule] = useState<RepeatRule>(
    task?.repeatRule ?? "once",
  );
  const repeatWeekday = task?.repeatWeekday ?? weekdayIndex(familyToday(timezone));
  // 每周任务可以多选星期。单天任务（包括所有老数据）的 repeatWeekdays 是空数组，
  // 所以这里退回 repeatWeekday 那一天；集合始终升序，服务端拿它拼 period_key。
  const [weekdays, setWeekdays] = useState<number[]>(() =>
    task?.repeatWeekdays?.length
      ? [...task.repeatWeekdays].sort((left, right) => left - right)
      : [repeatWeekday],
  );
  const toggleWeekday = (day: number) =>
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((picked) => picked !== day)
        : [...current, day].sort((left, right) => left - right),
    );
  const [saving, setSaving] = useState(false);
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <form
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-form-title"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || saving) return;
          setSaving(true);
          try {
            await onSave({
              title,
              description,
              category,
              points,
              repeatRule,
              repeatWeekday: weekdays[0] ?? repeatWeekday,
              repeatWeekdays: weekdays,
            });
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="form-heading">
          <div>
            <h2 id="task-form-title">{task ? "编辑任务信息" : "创建一个新任务"}</h2>
          </div>
          <button type="button" aria-label="关闭任务表单" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!task && (
          <div className="preset-list">
            <span className="preset-heading">推荐任务</span>
            {taskPresets.map((group) => (
              <div className="preset-group" key={group.category}>
                <span className="preset-cat">{group.category}</span>
                {group.items.map((preset) => (
                  <button
                    type="button"
                    className="preset-chip"
                    key={preset.title}
                    title={`${preset.description} · ${preset.points} 积分`}
                    onClick={() => {
                      setTitle(preset.title);
                      setDescription(preset.description);
                      setCategory(group.category);
                      setPoints(preset.points);
                      setRepeatRule(preset.repeatRule);
                    }}
                  >
                    {preset.title}
                    <b>{preset.points}</b>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        <label>
          任务名称
          <input
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：整理自己的书桌"
          />
        </label>
        <label>
          给孩子的小提示
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="说说要完成什么吧"
          />
        </label>
        <div className="form-grid">
          <label>
            分类
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.slice(1).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            奖励积分
            <input
              type="number"
              min="1"
              value={points}
              onChange={(e) => setPoints(Number(e.target.value))}
            />
          </label>
        </div>
        <label>
          重复方式
          <select
            value={repeatRule}
            onChange={(e) => setRepeatRule(e.target.value as RepeatRule)}
          >
            <option value="once">一次性</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </select>
        </label>
        {repeatRule === "weekly" && (
          <div className="weekday-picker">
            <span className="weekday-label">每周星期</span>
            <div className="weekday-row" role="group" aria-label="每周星期">
              {weekdayShort.map((day, index) => (
                <button
                  type="button"
                  key={day}
                  className="preset-chip weekday-chip"
                  aria-label={`每周${day}`}
                  aria-pressed={weekdays.includes(index)}
                  onClick={() => toggleWeekday(index)}
                >
                  {day}
                </button>
              ))}
            </div>
            <div className="weekday-quick">
              <button type="button" onClick={() => setWeekdays([1, 2, 3, 4, 5])}>
                工作日
              </button>
              <button type="button" onClick={() => setWeekdays([0, 6])}>
                周末
              </button>
              <button
                type="button"
                onClick={() => setWeekdays([0, 1, 2, 3, 4, 5, 6])}
              >
                全选
              </button>
            </div>
          </div>
        )}
        <button
          className="wide-primary"
          type="submit"
          disabled={saving || (repeatRule === "weekly" && weekdays.length === 0)}
          title={
            repeatRule === "weekly" && weekdays.length === 0
              ? "至少选一个星期"
              : undefined
          }
        >
          {saving ? "保存中…" : task ? "保存修改" : "发布任务"}
        </button>
      </form>
    </div>
  );
}

function ParentWishes({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Wish | null>(null);
  const [deleting, setDeleting] = useState<Wish | null>(null);
  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
  };
  return (
    <div className="parent-content">
      <ParentHeader
        title="愿望管理"
        action={
          <button
            className="primary-button"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Plus size={17} /> 添加愿望
          </button>
        }
      />
      <p className="section-description">
        把孩子真正期待的事情放进愿望小铺，用努力来兑换它们。
      </p>
      <div className="admin-wish-grid">
        {store.state.wishes.map((wish) => (
          <div
            className={`admin-wish ${wish.isActive ? "" : "inactive"}`}
            key={wish.id}
          >
            <div className="wish-art" style={{ background: wish.color }}>
              {wish.icon}
            </div>
            <div>
              <h3>{wish.title}</h3>
              <p>{wish.description}</p>
              <span className="cost">
                <Coins size={14} />
                {wish.pointsCost} 积分
              </span>
            </div>
            <div className="wish-admin-foot">
              <span
                className={`status-chip ${wish.isActive ? "status-completed" : "status-rejected"}`}
              >
                {wish.isActive ? "上架中" : "已下架"}
              </span>
              <div className="wish-admin-actions">
                <button
                  className="text-button"
                  onClick={() => store.actions.toggleWish(wish.id)}
                >
                  {wish.isActive ? "下架" : "重新上架"}
                </button>
                <button
                  className="icon-button"
                  onClick={() => setEditing(wish)}
                  aria-label={`编辑${wish.title}`}
                  title="编辑愿望"
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button danger-icon"
                  onClick={() => setDeleting(wish)}
                  aria-label={`删除${wish.title}`}
                  title="删除愿望"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="section-title">
        <h2>星愿清单</h2>
        {store.state.redemptions.length > 0 && (
          <span>
            {store.state.redemptions.filter((item) => item.completedAt).length}/
            {store.state.redemptions.length} 已实现
          </span>
        )}
      </div>
      <StarWishList
        items={[...store.state.redemptions].reverse().map((redemption) => ({
          redemption,
          ownerName: store.state.children.find(
            (child) => child.id === redemption.childId,
          )?.name,
        }))}
        timezone={store.state.timezone}
      />
      {(showForm || editing) && (
        <WishForm
          wish={editing}
          onClose={closeForm}
          onSave={async (draft) => {
            if (await store.actions.saveWish(draft, editing?.id)) closeForm();
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`删除「${deleting.title}」？`}
          text="愿望会从清单中移除，已经发生的兑换和积分记录会保留。"
          confirm="确认删除"
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            store.actions.deleteWish(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}


function WishForm({
  wish,
  onClose,
  onSave,
}: {
  wish: Wish | null;
  onClose: () => void;
  onSave: (draft: Omit<Wish, "id">) => Promise<unknown>;
}) {
  const colors = ["#ffcf70", "#ff9980", "#9bd8c8", "#bdb2ed"];
  const [title, setTitle] = useState(wish?.title ?? "");
  const [description, setDescription] = useState(wish?.description ?? "");
  const [pointsCost, setPoints] = useState(wish?.pointsCost ?? 100);
  const [icon, setIcon] = useState(wish?.icon ?? "🎁");
  const [color, setColor] = useState(wish?.color ?? colors[0]);
  const [saving, setSaving] = useState(false);
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <form
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wish-form-title"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || saving) return;
          setSaving(true);
          try {
            await onSave({
              title,
              description,
              pointsCost,
              icon,
              color,
              isActive: wish?.isActive ?? true,
            });
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="form-heading">
          <div>
            <h2 id="wish-form-title">{wish ? "编辑愿望信息" : "添加一个愿望"}</h2>
          </div>
          <button type="button" aria-label="关闭愿望表单" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          愿望名称
          <input
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：周末看一部电影"
          />
        </label>
        <label>
          愿望描述
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简单描述这个愿望"
          />
        </label>
        <div className="form-grid">
          <label>
            图标
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={2}
            />
          </label>
          <label>
            需要积分
            <input
              type="number"
              min="1"
              value={pointsCost}
              onChange={(e) => setPoints(Number(e.target.value))}
            />
          </label>
        </div>
        <fieldset>
          <legend>主题颜色</legend>
          <div className="color-options">
            {colors.map((item) => (
              <button
                type="button"
                key={item}
                className={color === item ? "selected" : ""}
                style={{ background: item }}
                onClick={() => setColor(item)}
                aria-label={`选择颜色${item}`}
              />
            ))}
          </div>
        </fieldset>
        <button className="wide-primary" type="submit" disabled={saving}>
          {saving ? "保存中…" : wish ? "保存修改" : "放入愿望小铺"}
        </button>
      </form>
    </div>
  );
}


export default App;
