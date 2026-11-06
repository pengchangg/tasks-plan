import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Image as ImageIcon, Pencil, Plus, Trash2, X } from "lucide-react";
import { useAppStore } from "../store";
import { shiftDate } from "../domain";
import { proverbForDate } from "../proverbs";
import { useDialog, EmptyState, SectionTitle, PageHeading, ConfirmModal, ZoomableImage, LunarTag } from "../ui";
import type { Attachment, Holiday, Homework, HomeworkDraft } from "../types";

// 作业 feature：孩子端首页模块与按日期浏览、家长端管理与表单、共享的作业卡与灯箱。
// 之前这些都堆在 App.tsx 里；它们只依赖 store 的 homework 切片与几个展示原语，
// 所以整块搬出来不影响路由或数据流。

// 跨天作业就是假期作业：范围由服务端按国办放假表算出（含假期前一天）。
const rangeText = (start: string, end: string) =>
  `${Number(start.slice(5, 7))}月${Number(start.slice(8))}日–${Number(end.slice(5, 7))}月${Number(end.slice(8))}日`;

// 作业的学科固定 10 项，与 internal/server/homework.go 的 homeworkSubjects 同名同序；
// 顺序就是表单里的单选顺序，也决定孩子端 chip 的 emoji 与配色。
const homeworkSubjects = [
  "语文",
  "数学",
  "英语",
  "科学",
  "道德与法治",
  "音乐",
  "美术",
  "体育",
  "劳动",
  "其他",
];
const subjectEmoji: Record<string, string> = {
  语文: "📖",
  数学: "🧮",
  英语: "🔤",
  科学: "🔬",
  道德与法治: "⚖️",
  音乐: "🎵",
  美术: "🎨",
  体育: "⚽",
  劳动: "🧹",
  其他: "📚",
};
// 列表里不认识的学科（历史数据、后来加过的学科）回退到「其他」的图标与配色：
// 服务端写入时只接受上面 10 个值，渲染这边仍然容错。
function subjectClass(subject: string): string {
  return homeworkSubjects.includes(subject) ? `subject-${subject}` : "subject-default";
}

export function ProverbBanner({ date }: { date: string }) {
  const proverb = proverbForDate(date);
  const chars = [...proverb.text];
  // pinyin 与 text 逐字符对齐：token 等于该位置的字符就说明它是标点，不包 <ruby>。
  const tokens = proverb.pinyin.split(" ");
  return (
    <section className="proverb-banner">
      <span className="proverb-label">每日谚语</span>
      <p className="proverb-text">
        {chars.map((char, index) =>
          tokens[index] === char ? (
            <span key={index}>{char}</span>
          ) : (
            <ruby key={index}>
              {char}
              <rt>{tokens[index]}</rt>
            </ruby>
          ),
        )}
      </p>
      <p className="proverb-english" lang="en">
        {proverb.english}
      </p>
    </section>
  );
}

export function HomeworkViewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: Attachment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const dialog = useDialog(onClose);
  const startX = useRef<number | null>(null);
  // 滑动本身也会在背景上冒泡出一次 click；标记一下就吞掉那一次，避免划过就关掉。
  const swiped = useRef(false);
  // 放大后单指拖动是平移，不再触发上一张/下一张。
  const scaleRef = useRef(1);
  const item = items[index];
  const step = (delta: number) => {
    // 上一张的放大不该留给下一张：缩放是每张图自己的状态，切图时归位。
    scaleRef.current = 1;
    onIndex((index + delta + items.length) % items.length);
  };
  return (
    <div
      className="modal-backdrop homework-viewer"
      ref={dialog}
      onClick={() => {
        if (swiped.current) {
          swiped.current = false;
          return;
        }
        onClose();
      }}
    >
      <figure
        className="viewer-stage"
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => {
          startX.current = event.touches[0]?.clientX ?? null;
          swiped.current = false;
        }}
        onTouchEnd={(event) => {
          const dx =
            (event.changedTouches[0]?.clientX ?? 0) - (startX.current ?? 0);
          startX.current = null;
          if (scaleRef.current > 1 || Math.abs(dx) < 50) return;
          swiped.current = true;
          step(dx < 0 ? 1 : -1);
        }}
      >
        {item.type === "video" ? (
          <video className="media-video" src={item.url} controls autoPlay playsInline />
        ) : (
          <ZoomableImage
            key={item.id}
            src={item.url}
            alt={item.name}
            onScaleChange={(scale) => {
              scaleRef.current = scale;
            }}
          />
        )}
        <figcaption>{item.name}</figcaption>
        <span className="viewer-count">
          {index + 1} / {items.length}
        </span>
      </figure>
      {items.length > 1 && (
        <>
          <button
            type="button"
            className="viewer-nav prev"
            aria-label="上一张"
            onClick={(event) => {
              event.stopPropagation();
              step(-1);
            }}
          >
            <ChevronLeft size={26} />
          </button>
          <button
            type="button"
            className="viewer-nav next"
            aria-label="下一张"
            onClick={(event) => {
              event.stopPropagation();
              step(1);
            }}
          >
            <ChevronRight size={26} />
          </button>
        </>
      )}
      <button className="modal-close" aria-label="关闭预览" onClick={onClose}>
        <X size={18} />
      </button>
    </div>
  );
}

export function HolidayBadge({ date, endDate }: { date: string; endDate: string }) {
  if (!endDate || endDate === date) return null;
  return (
    <span className="holiday-badge">假期作业 {rangeText(date, endDate)}</span>
  );
}

export function HomeworkDay({
  items,
  title,
  compact = false,
  onDone,
}: {
  items: Homework[];
  title: string;
  compact?: boolean;
  onDone?: (item: Homework, done: boolean) => Promise<number | undefined>;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  // 加分徽章跟着手指按住的那张卡：服务端算出的 awarded 只比本地翻勾晚几十毫秒，
  // 却是真账（重放、取消完成、积分不够都不会虚报），所以不拿本地猜测去画它。
  const [award, setAward] = useState<{ id: string; amount: number } | null>(null);
  const awardTimer = useRef(0);
  // 请求在途时禁掉那张卡的勾选框：连点两下会发 done=true / done=false 两个请求，
  // 服务端按到达顺序记账，孩子看到的 +N 可能和最终状态对不上。
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => () => window.clearTimeout(awardTimer.current), []);
  const tick = async (item: Homework, done: boolean) => {
    if (!onDone || pending.includes(item.id)) return;
    window.clearTimeout(awardTimer.current);
    if (!done) setAward(null);
    setPending((prev) => [...prev, item.id]);
    try {
      const awarded = await onDone(item, done);
      if (!awarded || awarded <= 0) return;
      setAward({ id: item.id, amount: awarded });
      awardTimer.current = window.setTimeout(() => setAward(null), 2000);
    } finally {
      setPending((prev) => prev.filter((id) => id !== item.id));
    }
  };
  const media = items.flatMap((item) => item.media);
  return (
    <>
      {items.map((item) => (
        <article
          className={`homework-card${item.done ? " done" : ""}`}
          key={item.id}
        >
          {onDone && (
            <label className="homework-check">
              <input
                type="checkbox"
                checked={item.done}
                disabled={pending.includes(item.id)}
                onChange={(event) => tick(item, event.target.checked)}
              />
              完成
            </label>
          )}
          {award?.id === item.id && (
            <span className="homework-award" aria-hidden="true">
              +{award.amount}
            </span>
          )}
          <span className={`subject-chip ${subjectClass(item.subject)}`}>
            <span>{subjectEmoji[item.subject] ?? subjectEmoji["其他"]}</span>
            {item.subject}
          </span>
          <HolidayBadge date={item.date} endDate={item.endDate} />
          {item.description && <p className="homework-desc">{item.description}</p>}
          {item.media.length > 0 && (
            <div className="media-grid">
              {item.media.map((attachment) => (
                <button
                  type="button"
                  key={attachment.id}
                  className="homework-thumb"
                  aria-label={`查看${attachment.name}`}
                  onClick={() => setViewing(media.indexOf(attachment))}
                >
                  {attachment.type === "video" ? (
                    <video src={attachment.url} muted preload="metadata" />
                  ) : (
                    <img src={attachment.url} alt={attachment.name} loading="lazy" />
                  )}
                  {attachment.type === "video" && <span className="media-badge">▶</span>}
                </button>
              ))}
            </div>
          )}
        </article>
      ))}
      {items.length === 0 && (
        <EmptyState
          icon="🎉"
          title={title}
          text="可以休息一下啦"
          compact={compact}
        />
      )}
      {viewing !== null && media.length > 0 && (
        <HomeworkViewer
          items={media}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

// 首页模块：孩子一进 app 就看到今天的作业与每日谚语（PRD §3.3 的「main 顶部、作业列表
// 上方」）。它永远看今天——刚在作业页翻到别的日期时，回到首页不能显示那一天。
export function TodayHomework({ store }: { store: ReturnType<typeof useAppStore> }) {
  const loadDate = store.actions.setHomeworkDate;
  useEffect(() => {
    if (store.homework.date !== store.today) loadDate(store.today);
  }, [store.homework.date, store.today, loadDate]);
  return (
    <section className="homework-module">
      <SectionTitle title="今日作业" action="按日期查看" to="/child/homework" />
      <ProverbBanner date={store.today} />
      <HomeworkDay
        items={store.homework.date === store.today ? store.homework.items : []}
        title="今日暂无作业"
        compact
        onDone={(item, done) =>
          store.actions.toggleHomeworkDone(item.id, done)
        }
      />
    </section>
  );
}

export function ChildHomework({ store }: { store: ReturnType<typeof useAppStore> }) {
  const date = store.homework.date || store.today;
  const isToday = date === store.today;
  const loadDate = store.actions.setHomeworkDate;
  useEffect(() => {
    // 第一次进入时 homework.date 还是空串，用家庭本地的今天补上。
    if (!store.homework.date) loadDate(store.today);
  }, [store.homework.date, store.today, loadDate]);
  const items = store.homework.items;
  return (
    <div className="content-wrap">
      <div className="homework-head">
        <h1>
          {isToday ? "今日作业" : `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日 · 作业`}
          {isToday && <span className="today-badge">今天</span>}
        </h1>
        <p>老师布置的作业都在这里，看完就开始吧。</p>
        <LunarTag date={date} state={store.state} />
        <div className="homework-date-bar">
          <button type="button" onClick={() => loadDate(shiftDate(date, -1))}>
            前一天
          </button>
          <input
            type="date"
            aria-label="选择日期"
            value={date}
            onChange={(event) => event.target.value && loadDate(event.target.value)}
          />
          <button type="button" onClick={() => loadDate(shiftDate(date, 1))}>
            后一天
          </button>
          {!isToday && (
            <button
              type="button"
              className="today-button"
              onClick={() => loadDate(store.today)}
            >
              回到今天
            </button>
          )}
        </div>
      </div>
      <ProverbBanner date={date} />
      <HomeworkDay
        items={items}
        title={isToday ? "今日暂无作业" : "这一天没有作业"}
        onDone={(item, done) =>
          store.actions.toggleHomeworkDone(item.id, done)
        }
      />
    </div>
  );
}

export function ParentHomework({ store }: { store: ReturnType<typeof useAppStore> }) {
  const date = store.homework.date || store.today;
  const loadDate = store.actions.setHomeworkDate;
  useEffect(() => {
    if (!store.homework.date) loadDate(store.today);
  }, [store.homework.date, store.today, loadDate]);
  const [editing, setEditing] = useState<Homework | "new" | null>(null);
  const [deleting, setDeleting] = useState<Homework | null>(null);
  return (
    <div className="parent-content">
      <PageHeading
        title="作业管理"
        description="把老师布置的作业拍下来，孩子打开平板就能看到。"
      />
      <div className="homework-toolbar">
        <input
          type="date"
          aria-label="作业日期"
          value={date}
          onChange={(event) => event.target.value && loadDate(event.target.value)}
        />
        <LunarTag date={date} state={store.state} />
        <button
          type="button"
          className="primary-button"
          onClick={() => setEditing("new")}
        >
          <Plus size={15} />
          新增作业
        </button>
      </div>
      {store.homework.items.map((item) => (
        <div className="homework-admin-row" key={item.id}>
          <span className={`subject-chip ${subjectClass(item.subject)}`}>
            <span>{subjectEmoji[item.subject] ?? subjectEmoji["其他"]}</span>
            {item.subject}
          </span>
          <HolidayBadge date={item.date} endDate={item.endDate} />
          <span className="homework-media-count">{item.media.length} 个附件</span>
          <div className="homework-admin-actions">
            <button
              type="button"
              aria-label={`编辑${item.subject}`}
              onClick={() => setEditing(item)}
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              aria-label={`删除${item.subject}`}
              onClick={() => setDeleting(item)}
            >
              <Trash2 size={16} />
            </button>
          </div>
          {item.description && <p className="homework-desc">{item.description}</p>}
        </div>
      ))}
      {store.homework.items.length === 0 && (
        <EmptyState
          icon="📚"
          title="这条日期还没有作业"
          text="点「新增作业」把老师布置的内容记下来"
        />
      )}
      {editing && (
        <HomeworkForm
          homework={editing === "new" ? null : editing}
          date={editing === "new" ? date : editing.date}
          holiday={store.homework.holiday}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            if (
              await store.actions.saveHomework(
                draft,
                editing === "new" ? undefined : editing.id,
              )
            )
              setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="删除这条作业？"
          text="删除后图片和视频也会一起移除。"
          confirm="确认删除"
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            store.actions.deleteHomework(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

export function HomeworkForm({
  homework,
  date,
  holiday,
  onClose,
  onSave,
}: {
  homework: Homework | null;
  date: string;
  holiday?: Holiday;
  onClose: () => void;
  onSave: (draft: HomeworkDraft) => Promise<unknown>;
}) {
  const dialog = useDialog(onClose);
  // 所选日期落在假期内（或假期前一天）时默认预填整段假期：开始日期也从假期首日起，
  // 否则在假期中途新增会得到一段残缺的范围；家长仍可把任一端改短。
  const [value, setValue] = useState(
    homework ? homework.date : (holiday?.start ?? date),
  );
  // shortcut: 手改日期输入框不会重算假期，家长自己决定结束日期。
  const [endValue, setEndValue] = useState(
    homework ? homework.endDate || homework.date : (holiday?.end ?? date),
  );
  const [subject, setSubject] = useState(
    homework
      ? homeworkSubjects.includes(homework.subject)
        ? homework.subject
        : "其他"
      : "语文",
  );
  const [description, setDescription] = useState(homework?.description ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // 预览用的是 blob URL，卸载时必须逐个回收（删除单项时也立刻回收；重复回收无害）。
  const created = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of created.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const kept = (homework?.media ?? []).filter(
    (media) => !removed.includes(media.id ?? ""),
  );
  const pick = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const added = [...picked];
    const urls = added.map((file) => URL.createObjectURL(file));
    created.current.push(...urls);
    setFiles((current) => [...current, ...added]);
    setPreviews((current) => [...current, ...urls]);
  };
  const drop = (index: number) => {
    URL.revokeObjectURL(previews[index]);
    setFiles((current) => current.filter((_, i) => i !== index));
    setPreviews((current) => current.filter((_, i) => i !== index));
  };
  return (
    <div className="modal-backdrop" ref={dialog}>
      <form
        className="form-modal homework-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="homework-form-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          // 描述与图片/视频至少填一项（PRD §3.2）。
          if (!description.trim() && kept.length + files.length === 0) {
            setError("请填写文字描述或选择图片或视频");
            return;
          }
          setSaving(true);
          try {
            await onSave({
              date: value,
              endDate: endValue || value,
              subject,
              description: description.trim(),
              files,
              removeMedia: removed,
            });
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="form-heading">
          <div>
            <h2 id="homework-form-title">
              {homework ? "编辑作业" : "新增作业"}
            </h2>
          </div>
          <button type="button" aria-label="关闭作业表单" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          日期
          <input
            type="date"
            required
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            required
            min={value}
            value={endValue || value}
            onChange={(event) => setEndValue(event.target.value || value)}
          />
        </label>
        {holiday && (
          <p className="holiday-hint">
            <span>
              {holiday.name} · {rangeText(holiday.start, holiday.end)} 共{" "}
              {holiday.days} 天
            </span>
            {(value !== holiday.start || endValue !== holiday.end) && (
              <button
                type="button"
                onClick={() => {
                  setValue(holiday.start);
                  setEndValue(holiday.end);
                }}
              >
                设为整段假期
              </button>
            )}
          </p>
        )}
        <div className="form-field">
          <span>学科</span>
          <div className="subject-picker" role="group" aria-label="学科">
            {homeworkSubjects.map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={name === subject}
                className={`subject-option ${subjectClass(name)}${name === subject ? " active" : ""}`}
                onClick={() => setSubject(name)}
              >
                <span>{subjectEmoji[name]}</span>
                {name}
              </button>
            ))}
          </div>
        </div>
        <label>
          文字描述
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="抄写老师布置的作业内容…"
          />
        </label>
        <div className="form-field">
          <span>图片 / 视频</span>
          <label className="upload-card">
            <input
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(event) => pick(event.target.files)}
            />
            <ImageIcon size={22} />
            <span>
              {files.length
                ? `已选 ${files.length} 个文件 · 点击更换`
                : "点击选择图片或视频"}
            </span>
          </label>
          {(kept.length > 0 || files.length > 0) && (
            <div className="upload-previews">
              {kept.map((media) => (
                <div className="upload-preview" key={media.id}>
                  {media.type === "video" ? (
                    <video src={media.url} muted preload="metadata" />
                  ) : (
                    <img src={media.url} alt={media.name} />
                  )}
                  <button
                    type="button"
                    className="upload-remove"
                    aria-label={`删除${media.name}`}
                    onClick={() =>
                      setRemoved((current) => [...current, media.id ?? ""])
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              {files.map((file, index) => (
                <div className="upload-preview" key={`${file.name}-${index}`}>
                  {file.type.startsWith("video") ? (
                    <video src={previews[index]} muted preload="metadata" />
                  ) : (
                    <img src={previews[index]} alt={file.name} />
                  )}
                  <button
                    type="button"
                    className="upload-remove"
                    aria-label={`删除${file.name}`}
                    onClick={() => drop(index)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button className="wide-primary" type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存作业"}
          </button>
        </div>
      </form>
    </div>
  );
}
