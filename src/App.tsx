import { useEffect, useMemo, useRef, useState } from "react";
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
  ChevronRight,
  ClipboardCheck,
  Coins,
  Gift,
  Home,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Menu,
  MessageSquare,
  Pencil,
  Plus,
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
import type {
  Attachment,
  Child,
  PointLedger,
  RepeatRule,
  Task,
  TaskSubmission,
  Wish,
} from "./types";
import "./styles.css";

const categories = ["全部", "生活自理", "学习成长", "家庭责任"];
const statusLabel = {
  todo: "待完成",
  pending_review: "待确认",
  completed: "已完成",
  rejected: "再试一次",
};
const dateText = (date: string) =>
  date === new Date().toISOString().slice(0, 10)
    ? "今天"
    : date.slice(5).replace("-", "月") + "日";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<Shell />} />
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
  const [parentGate, setParentGate] = useState<{ returnTo: string } | null>(
    null,
  );
  const parentUnlocked = store.state.role === "parent";
  const [reward, setReward] = useState<PointLedger | null>(null);
  const latestEarned = store.state.ledger
    .filter(
      (item) => item.childId === store.activeChild.id && item.type === "earned",
    )
    .slice(-1)[0];
  const seenRewards = useRef(
    new Map(
      store.state.children.map((child) => [
        child.id,
        store.state.ledger
          .filter((item) => item.childId === child.id && item.type === "earned")
          .slice(-1)[0]?.id,
      ]),
    ),
  );
  useEffect(() => {
    if (isParent) {
      setReward(null);
      return;
    }
    if (
      !latestEarned ||
      seenRewards.current.get(store.activeChild.id) === latestEarned.id
    )
      return;
    seenRewards.current.set(store.activeChild.id, latestEarned.id);
    setReward(latestEarned);
    const timer = window.setTimeout(() => setReward(null), 3600);
    return () => window.clearTimeout(timer);
  }, [isParent, latestEarned, store.activeChild.id]);
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
      <div className="login-screen">
        <p>正在连接成长空间...</p>
      </div>
    );
  if (!store.connected)
    return (
      <main className="login-screen">
        <div className="login-panel">
          <span className="brand-mark">✦</span>
          <span className="eyebrow">GROWJOY FAMILY</span>
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
          <span className="brand-mark">✦</span>
          <span>小小成长家</span>
        </Link>
        <div className="top-actions">
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
          </div>
        )}
      </header>
      {parentGate && (
        <ParentPinModal
          onClose={() => setParentGate(null)}
          onConfirm={unlockParent}
        />
      )}
      {store.message && (
        <div className="app-toast" role="alert">
          <span>{store.message}</span>
          <button onClick={store.dismissMessage} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
      {reward && (
        <RewardCelebration reward={reward} onClose={() => setReward(null)} />
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
  return (
    <div className="modal-backdrop">
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
        <span className="eyebrow">PARENT ACCESS</span>
        <h2 id="parent-pin-title">进入家长端</h2>
        <p>请输入家长密码，孩子无法直接进入管理页面。</p>
        <label htmlFor="parent-pin">家长密码</label>
        <input
          id="parent-pin"
          autoFocus
          type="password"
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
        <small className="pin-hint">演示密码：growjoy2468</small>
        <button
          className="wide-primary"
          type="submit"
          disabled={pin.length < 8}
        >
          验证并进入
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
        <span>任务确认完成</span>
        <strong>+{reward.amount} 积分到账！</strong>
        <small>{reward.description}</small>
      </div>
      <button onClick={onClose} aria-label="关闭积分到账提示">
        <X size={17} />
      </button>
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
          <Route path="/child/wishes" element={<ChildWishes store={store} />} />
          <Route path="/child/growth" element={<Growth store={store} />} />
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
  const done = tasks.filter((t) => t.status === "completed").length;
  const pending = tasks.filter((t) => t.status === "pending_review").length;
  return (
    <div className="content-wrap child-home">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">
            星期
            {["日", "一", "二", "三", "四", "五", "六"][new Date().getDay()]} ·{" "}
            {new Date().getMonth() + 1}月{new Date().getDate()}日
          </p>
          <h1>
            嗨，{child.name} <span className="wave">✦</span>
          </h1>
          <p className="muted">今天也一起收集小小成就吧</p>
        </div>
        <div className="streak">
          <span>🔥</span>
          <strong>{child.streakDays}</strong>
          <small>天连续</small>
        </div>
      </div>
      <section
        className="companion-banner"
        style={{ "--companion": child.color } as React.CSSProperties}
      >
        <div className="sun-dots">✦</div>
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
      <SectionTitle title="今天要做什么" action="查看全部" to="/child/tasks" />
      <div className="task-list">
        {tasks.slice(0, 3).map((task) => (
          <TaskCard
            key={task.id}
            task={task}
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
      <SectionTitle title="愿望小铺" action="全部愿望" to="/child/wishes" />
      <div className="wish-strip">
        {store.state.wishes.slice(0, 3).map((wish) => (
          <WishMini key={wish.id} wish={wish} balance={child.pointsBalance} />
        ))}
      </div>
    </div>
  );
}

function SectionTitle({
  title,
  action,
  to,
}: {
  title: string;
  action: string;
  to: string;
}) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <Link to={to}>
        {action}
        <ChevronRight size={15} />
      </Link>
    </div>
  );
}
function TaskCard({
  task,
  onSubmit,
  parent = false,
  onReview,
}: {
  task: Task;
  onSubmit?: (id: string, note: string, attachments: Attachment[]) => void;
  parent?: boolean;
  onReview?: (id: string, approved: boolean, note?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [attachment, setAttachment] = useState<Attachment[]>([]);
  const submit = () => {
    onSubmit?.(task.id, note, attachment);
    setOpen(false);
  };
  return (
    <article className={`task-card ${task.status}`}>
      <div className={`task-symbol cat-${task.category}`}>
        {task.category === "学习成长"
          ? "✎"
          : task.category === "家庭责任"
            ? "⌂"
            : "✦"}
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
          <span className="due">{dateText(task.dueDate)}</span>
          {task.status === "todo" && !parent && (
            <button className="small-primary" onClick={() => setOpen(true)}>
              完成任务
            </button>
          )}
          {task.status === "pending_review" && parent && (
            <div className="review-actions">
              <button
                className="approve"
                onClick={() => onReview?.(task.id, true)}
              >
                确认完成
              </button>
              <button
                className="reject"
                onClick={() => onReview?.(task.id, false, "再检查一下哦")}
              >
                退回
              </button>
            </div>
          )}
          {task.status === "rejected" && !parent && (
            <button className="small-primary" onClick={() => setOpen(true)}>
              重新提交
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="task-submit">
          <div className="submit-head">
            <strong>完成得怎么样？</strong>
            <button onClick={() => setOpen(false)}>
              <X size={17} />
            </button>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="写一句话告诉家长吧（可选）"
          />
          <div className="attachment-row">
            <label>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []).map(
                    (file) => ({
                      name: file.name,
                      type: "image" as const,
                      file,
                    }),
                  );
                  setAttachment((current) => [
                    ...current.filter((item) => item.type !== "image"),
                    ...selected,
                  ]);
                }}
              />
              <span>＋ 添加照片</span>
            </label>
            <label>
              <input
                type="file"
                accept="video/*"
                multiple
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []).map(
                    (file) => ({
                      name: file.name,
                      type: "video" as const,
                      file,
                    }),
                  );
                  setAttachment((current) => [
                    ...current.filter((item) => item.type !== "video"),
                    ...selected,
                  ]);
                }}
              />
              <span>＋ 添加视频</span>
            </label>
          </div>
          {attachment.length > 0 && (
            <div className="attachment-name">
              {attachment.map((item, index) => (
                <small key={`${item.name}-${index}`}>✓ {item.name}</small>
              ))}
            </div>
          )}
          <button className="wide-primary" onClick={submit}>
            提交给家长确认
          </button>
        </div>
      )}
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
        eyebrow="MY TASKS"
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
          <TaskCard key={t.id} task={t} onSubmit={store.actions.submitTask} />
        ))}
      </div>
      {tasks.length === 0 && (
        <EmptyState icon="✦" title="这里还没有任务" text="去找家长安排一个吧" />
      )}
    </div>
  );
}
function ChildWishes({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [selected, setSelected] = useState<Wish | null>(null);
  return (
    <div className="content-wrap">
      <PageHeading
        eyebrow="WISH SHOP"
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
        {balance >= wish.pointsCost ? "可兑换" : "继续努力"}
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
  const tasks = store.childTasks;
  const done = tasks.filter((t) => t.status === "completed").length;
  const earned = store.state.ledger
    .filter((l) => l.childId === store.activeChild.id && l.type === "earned")
    .reduce((a, b) => a + b.amount, 0);
  return (
    <div className="content-wrap">
      <PageHeading
        eyebrow="MY GROWTH"
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
      <section className="chart-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">LAST 7 DAYS</span>
            <h2>完成趋势</h2>
          </div>
          <span className="chart-total">
            {done} <small>次完成</small>
          </span>
        </div>
        <div className="bar-chart">
          {["一", "二", "三", "四", "五", "六", "日"].map((day, i) => (
            <div className="bar-col" key={day}>
              <div
                className={`bar ${i < 5 ? "filled" : ""}`}
                style={{ height: `${[45, 68, 32, 85, 58, 20, 35][i]}%` }}
              >
                <span />
              </div>
              <small>{day}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="achievement">
        <div className="achievement-badge">🌱</div>
        <div>
          <span className="eyebrow">NEW ACHIEVEMENT</span>
          <h3>连续坚持 5 天</h3>
          <p>再坚持一天，就能解锁新的徽章啦！</p>
        </div>
        <ChevronRight size={18} />
      </section>
    </div>
  );
}
function Metric({
  icon,
  value,
  label,
  color,
}: {
  icon: string;
  value: string;
  label: string;
  color: string;
}) {
  return (
    <div className={`metric ${color}`}>
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
function EmptyState({
  icon,
  title,
  text,
}: {
  icon: string;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function ConfirmModal({
  title,
  text,
  confirm,
  onClose,
  onConfirm,
}: {
  title: string;
  text: string;
  confirm: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <button className="modal-close" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="modal-icon">🎁</div>
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            再想想
          </button>
          <button className="wide-primary" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function ParentLayout({ store }: { store: ReturnType<typeof useAppStore> }) {
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
          />
          <SideLink
            to="/parent/children"
            icon={<Users size={18} />}
            label="孩子管理"
          />
          <SideLink
            to="/parent/tasks"
            icon={<ClipboardCheck size={18} />}
            label="任务管理"
          />
          <SideLink
            to="/parent/wishes"
            icon={<Gift size={18} />}
            label="愿望管理"
          />
          <SideLink
            to="/parent/stats"
            icon={<BarChart3 size={18} />}
            label="成长统计"
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
          <Route path="/parent/stats" element={<ParentStats store={store} />} />
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
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  const location = useLocation();
  return (
    <Link className={location.pathname === to ? "active" : ""} to={to}>
      {icon}
      <span>{label}</span>
      <ChevronRight size={14} />
    </Link>
  );
}
function ParentHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="parent-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {action}
    </div>
  );
}
function ParentOverview({ store }: { store: ReturnType<typeof useAppStore> }) {
  const tasks = store.childTasks;
  const pending = tasks.filter((t) => t.status === "pending_review");
  const done = store.stats.completedTasks;
  const total = store.stats.totalTasks;
  return (
    <div className="parent-content">
      <ParentHeader
        eyebrow="FAMILY DASHBOARD"
        title="家庭总览"
        action={
          <Link
            className="outline-button"
            to="/child"
            onClick={() => store.actions.enterChild()}
          >
            <Sparkles size={16} /> 看看孩子端
          </Link>
        }
      />
      <div className="parent-welcome">
        <div>
          <span className="pill light-pill">
            今天 · {new Date().getMonth() + 1}月{new Date().getDate()}日
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
        <Link to="/parent/tasks">
          查看全部 <ChevronRight size={15} />
        </Link>
      </div>
      {pending.length ? (
        <div className="review-list">
          {pending.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
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
                  {new Date(item.createdAt).toLocaleDateString("zh-CN")}
                </small>
              </div>
              <b className={item.type === "earned" ? "positive" : "negative"}>
                {item.amount > 0 ? "+" : ""}
                {item.amount}
              </b>
            </div>
          ))}
      </div>
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
        eyebrow="CHILD PROFILES"
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
          onSave={(draft) => {
            store.actions.saveChild(draft, editing?.id);
            setShowForm(false);
            setEditing(null);
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
  onSave: (draft: Pick<Child, "name" | "avatar" | "color">) => void;
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
  return (
    <div className="modal-backdrop">
      <form
        className="form-modal child-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim())
            onSave({
              name: name.trim(),
              avatar,
              color,
            });
        }}
      >
        <div className="form-heading">
          <div>
            <span className="eyebrow">CHILD PROFILE</span>
            <h2>{child ? "编辑孩子档案" : "添加一个孩子"}</h2>
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
        <button className="wide-primary" type="submit">
          {child ? "保存修改" : "添加孩子"}
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
  const latestSubmissions = useMemo(() => {
    const byTask = new Map<string, TaskSubmission>();
    store.state.submissions
      .filter((submission) => submission.childId === store.activeChild.id)
      .forEach((submission) => byTask.set(submission.taskId, submission));
    return byTask;
  }, [store.activeChild.id, store.state.submissions]);
  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
  };
  return (
    <div className="parent-content">
      <ParentHeader
        eyebrow="TASK MANAGEMENT"
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
            submission={latestSubmissions.get(task.id)}
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
          onClose={closeForm}
          onSave={(draft) => {
            store.actions.saveTask(
              { ...draft, childId: store.state.activeChildId },
              editing?.id,
            );
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
function AdminTaskRow({
  task,
  submission,
  onReview,
  onEdit,
  onDelete,
}: {
  task: Task;
  submission?: TaskSubmission;
  onReview: (id: string, ok: boolean, note?: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="admin-task-item">
      <div className="admin-row">
        <div className={`task-symbol cat-${task.category}`}>
          {task.category === "学习成长"
            ? "✎"
            : task.category === "家庭责任"
              ? "⌂"
              : "✦"}
        </div>
        <div className="admin-row-main">
          <div>
            <h3>{task.title}</h3>
            <p>
              {task.category} ·{" "}
              {task.repeatRule === "daily"
                ? "每天"
                : task.repeatRule === "weekly"
                  ? `每周${["日", "一", "二", "三", "四", "五", "六"][task.repeatWeekday ?? 1]}`
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
          <div className="review-actions">
            <button className="approve" onClick={() => onReview(task.id, true)}>
              确认
            </button>
            <button
              className="reject"
              onClick={() => onReview(task.id, false, "再检查一下哦")}
            >
              退回
            </button>
          </div>
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
        <div className="submission-evidence">
          <div className="evidence-heading">
            <strong>孩子提交</strong>
            <time dateTime={submission.submittedAt}>
              {new Date(submission.submittedAt).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
          {submission.note ? (
            <p className="submission-note">
              <MessageSquare size={15} />
              <span>{submission.note}</span>
            </p>
          ) : (
            <p className="empty-evidence">未填写文字备注</p>
          )}
          <div className="attachment-list">
            {submission.attachments.length > 0 ? (
              submission.attachments.map((attachment, index) => (
                <span
                  className="attachment-chip"
                  key={`${attachment.name}-${index}`}
                >
                  {attachment.type === "image" ? (
                    <ImageIcon size={15} />
                  ) : (
                    <Video size={15} />
                  )}
                  <span>{attachment.name}</span>
                  <small>{attachment.type === "image" ? "照片" : "视频"}</small>
                </span>
              ))
            ) : (
              <span className="empty-evidence">未添加照片或视频</span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
function TaskForm({
  task,
  onClose,
  onSave,
}: {
  task: Task | null;
  onClose: () => void;
  onSave: (draft: {
    title: string;
    description: string;
    category: string;
    points: number;
    repeatRule: RepeatRule;
    repeatWeekday: number;
  }) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [category, setCategory] = useState(task?.category ?? "生活自理");
  const [points, setPoints] = useState(task?.points ?? 20);
  const [repeatRule, setRepeatRule] = useState<RepeatRule>(
    task?.repeatRule ?? "once",
  );
  const [repeatWeekday, setRepeatWeekday] = useState(
    task?.repeatWeekday ?? new Date().getDay(),
  );
  return (
    <div className="modal-backdrop">
      <form
        className="form-modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim())
            onSave({
              title,
              description,
              category,
              points,
              repeatRule,
              repeatWeekday,
            });
        }}
      >
        <div className="form-heading">
          <div>
            <span className="eyebrow">{task ? "EDIT TASK" : "NEW TASK"}</span>
            <h2>{task ? "编辑任务信息" : "创建一个新任务"}</h2>
          </div>
          <button type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          任务名称
          <input
            required
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
          <label>
            每周星期
            <select
              value={repeatWeekday}
              onChange={(e) => setRepeatWeekday(Number(e.target.value))}
            >
              {[
                "星期日",
                "星期一",
                "星期二",
                "星期三",
                "星期四",
                "星期五",
                "星期六",
              ].map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="wide-primary" type="submit">
          {task ? "保存修改" : "发布任务"}
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
        eyebrow="WISH MANAGEMENT"
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
      {(showForm || editing) && (
        <WishForm
          wish={editing}
          onClose={closeForm}
          onSave={(draft) => {
            store.actions.saveWish(draft, editing?.id);
            closeForm();
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
  onSave: (draft: Omit<Wish, "id">) => void;
}) {
  const colors = ["#ffcf70", "#ff9980", "#9bd8c8", "#bdb2ed"];
  const [title, setTitle] = useState(wish?.title ?? "");
  const [description, setDescription] = useState(wish?.description ?? "");
  const [pointsCost, setPoints] = useState(wish?.pointsCost ?? 100);
  const [icon, setIcon] = useState(wish?.icon ?? "🎁");
  const [color, setColor] = useState(wish?.color ?? colors[0]);
  return (
    <div className="modal-backdrop">
      <form
        className="form-modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim())
            onSave({
              title,
              description,
              pointsCost,
              icon,
              color,
              isActive: wish?.isActive ?? true,
            });
        }}
      >
        <div className="form-heading">
          <div>
            <span className="eyebrow">{wish ? "EDIT WISH" : "NEW WISH"}</span>
            <h2>{wish ? "编辑愿望信息" : "添加一个愿望"}</h2>
          </div>
          <button type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          愿望名称
          <input
            required
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
        <button className="wide-primary" type="submit">
          {wish ? "保存修改" : "放入愿望小铺"}
        </button>
      </form>
    </div>
  );
}

function ParentStats({ store }: { store: ReturnType<typeof useAppStore> }) {
  const done = store.stats.completedTasks;
  const earned = store.stats.earnedPoints;
  const spent = store.stats.spentPoints;
  const maxCompleted = Math.max(
    1,
    ...store.stats.daily.map((day) => day.completed),
  );
  const topCategory = [...store.stats.categories].sort(
    (left, right) => right.count - left.count,
  )[0];
  return (
    <div className="parent-content">
      <ParentHeader
        eyebrow="GROWTH REPORT"
        title="成长统计"
        action={
          <div className="date-select">
            最近 7 天 <ChevronRight size={15} />
          </div>
        }
      />
      <div className="stats-cards">
        <div>
          <span>完成任务</span>
          <strong>{done}</strong>
          <small>次 / {store.stats.totalTasks} 个任务</small>
        </div>
        <div>
          <span>获得积分</span>
          <strong>{earned}</strong>
          <small>最近 7 天</small>
        </div>
        <div>
          <span>兑换愿望</span>
          <strong>{spent}</strong>
          <small>分</small>
        </div>
      </div>
      <div className="stats-layout">
        <section className="chart-panel parent-chart">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">TASK COMPLETION</span>
              <h2>任务完成趋势</h2>
            </div>
            <span>最近 7 天</span>
          </div>
          <div className="bar-chart tall">
            {store.stats.daily.map((day) => (
              <div className="bar-col" key={day.date}>
                <div
                  className="bar filled"
                  title={`${day.label}完成 ${day.completed} 个任务`}
                  style={{
                    height: `${day.completed === 0 ? 0 : Math.max(12, (day.completed / maxCompleted) * 100)}%`,
                  }}
                />
                <small>{day.label}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="category-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">BY CATEGORY</span>
              <h2>完成分布</h2>
            </div>
          </div>
          {store.stats.categories.map((category) => {
            const color =
              {
                生活自理: "#ffb547",
                家庭责任: "#55b8a4",
                学习成长: "#9d8be8",
              }[category.name] ?? "#67a9dc";
            return (
              <div className="category-line" key={category.name}>
                <div>
                  <span
                    className="category-dot"
                    style={{ background: color }}
                  />
                  <span>{category.name}</span>
                  <b>{category.percent}%</b>
                </div>
                <div className="progress">
                  <span
                    style={{ width: `${category.percent}%`, background: color }}
                  />
                </div>
              </div>
            );
          })}
        </section>
      </div>
      <section className="insight-card">
        <span>💡</span>
        <div>
          <strong>小提示</strong>
          <p>
            {topCategory?.count
              ? `${store.activeChild.name}最近在「${topCategory.name}」类任务上完成得最多，可以继续保持这个节奏。`
              : `${store.activeChild.name}最近 7 天还没有确认完成的任务，完成后这里会出现成长洞察。`}
          </p>
        </div>
      </section>
    </div>
  );
}

export default App;
