import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { familyDate, shiftDate } from "../domain";
import { EmptyState, ParentHeader, StarMark } from "../ui";
import type { StatsPayload } from "../types";

// 统计 feature：家长端的成长统计页。它的常量、区间标题和页面一起搬出来，
// App.tsx 只保留路由。statsMaxRangeDays 与服务端同名常量保持同值。

const statsMaxRangeDays = 92;
const statsRanges = [
  { key: "today", label: "今天" },
  { key: "week", label: "最近 7 天" },
  { key: "month", label: "最近 30 天" },
  { key: "custom", label: "自定义" },
] as const;
type StatsRangeKey = (typeof statsRanges)[number]["key"];

// 区间标题：预设用固定说法，自定义用服务端回显的 from/to（同一年只写月日）。
function statsRangeLabel(key: StatsRangeKey, stats: StatsPayload): string {
  const preset = statsRanges.find((item) => item.key === key);
  if (key !== "custom") return preset?.label ?? "";
  const [fromYear, fromMonth, fromDay] = stats.from.split("-").map(Number);
  const [toYear, toMonth, toDay] = stats.to.split("-").map(Number);
  const short = (year: number, month: number, day: number) =>
    year === toYear ? `${month}月${day}日` : `${year}年${month}月${day}日`;
  return `${short(fromYear, fromMonth, fromDay)} - ${short(toYear, toMonth, toDay)}`;
}

export function ParentStats({ store }: { store: ReturnType<typeof useAppStore> }) {
  const today = familyDate(new Date().toISOString(), store.state.timezone);
  const [rangeKey, setRangeKey] = useState<StatsRangeKey>("week");
  const [draft, setDraft] = useState({ from: today, to: today });
  const [applied, setApplied] = useState({ from: today, to: today });
  // 首屏先用 store 的默认 7 天载荷，避免闪一次空图表；随后的区间请求会覆盖它。
  const [stats, setStats] = useState<StatsPayload>(store.stats);
  const range =
    rangeKey === "today"
      ? { from: today, to: today }
      : rangeKey === "week"
        ? { from: shiftDate(today, -6), to: today }
        : rangeKey === "month"
          ? { from: shiftDate(today, -29), to: today }
          : applied;
  useEffect(() => {
    let live = true;
    void store.actions.loadStats(range.from, range.to).then((payload) => {
      if (live && payload) setStats(payload);
    });
    return () => {
      live = false;
    };
    // 只跟着「看哪个孩子」与区间走：依赖整个 state 会让每 60 秒的轮询和每次写操作
    // 都重拉一遍 /stats。
  }, [store.activeChild.id, range.from, range.to]);
  const rangeLabel = statsRangeLabel(rangeKey, stats);
  const done = stats.completedTasks;
  const earned = stats.earnedPoints;
  const spent = stats.spentPoints;
  const maxCompleted = Math.max(1, ...stats.daily.map((day) => day.completed));
  // 长区间有几十根柱子，只给 7 根留标签位置，其余留空占位保持列高一致。
  const labelStep = Math.ceil(stats.daily.length / 7);
  const topCategory = [...stats.categories].sort(
    (left, right) => right.count - left.count,
  )[0];
  const empty =
    stats.totalTasks === 0 &&
    stats.completedTasks === 0 &&
    stats.earnedPoints === 0 &&
    stats.spentPoints === 0;
  return (
    <div className="parent-content">
      <ParentHeader
        title="成长统计"
        action={
          <div className="range-picker">
            <label>
              统计范围
              <select
                value={rangeKey}
                onChange={(e) => setRangeKey(e.target.value as StatsRangeKey)}
              >
                {statsRanges.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      />
      {rangeKey === "custom" && (
        <div className="range-custom">
          <label>
            开始日期
            <input
              type="date"
              value={draft.from}
              min={shiftDate(today, -(statsMaxRangeDays - 1))}
              max={today}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={draft.to}
              min={shiftDate(today, -(statsMaxRangeDays - 1))}
              max={today}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </label>
          <button
            className="primary-button"
            disabled={!draft.from || !draft.to || draft.from > draft.to}
            onClick={() => setApplied(draft)}
          >
            应用
          </button>
        </div>
      )}
      <div className="stats-cards">
        <div>
          <span>完成任务</span>
          <strong>{done}</strong>
          <small>次 / 应完成 {stats.totalTasks} 个</small>
        </div>
        <div>
          <span>获得积分</span>
          <strong>{earned}</strong>
          <small>{rangeLabel}</small>
        </div>
        <div>
          <span>消费积分</span>
          <strong>{spent}</strong>
          <small>分</small>
        </div>
      </div>
      {empty ? (
        <EmptyState
          icon={<StarMark size={22} />}
          title="这段时间还没有记录"
          text="换个日期范围，或者先去确认孩子的任务吧"
        />
      ) : (
        <div className="stats-layout">
          <section className="chart-panel parent-chart">
            <div className="panel-heading">
              <div>
                <h2>任务完成趋势</h2>
              </div>
              <span>{rangeLabel}</span>
            </div>
            <div className="bar-chart">
              {stats.daily.map((day, index) => (
                <div className="bar-col" key={day.date}>
                  <span className="bar-value">
                    {stats.daily.length <= 14 ? day.completed : ""}
                  </span>
                  <div className="bar-track">
                    <div
                      className={`bar${day.completed ? " filled" : ""}`}
                      title={`${day.date} 完成 ${day.completed} 个任务`}
                      style={{
                        height: `${(day.completed / maxCompleted) * 100}%`,
                      }}
                    />
                  </div>
                  {index % labelStep === 0 || index === stats.daily.length - 1 ? (
                    <small>{day.label}</small>
                  ) : (
                    <small />
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="category-panel">
            <div className="panel-heading">
              <div>
                <h2>完成分布</h2>
              </div>
            </div>
            {stats.categories.length === 0 ? (
              <p className="empty-evidence">这段时间没有确认完成的任务</p>
            ) : (
              stats.categories.map((category) => {
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
                        style={{
                          width: `${category.percent}%`,
                          background: color,
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}
      <section className="insight-card">
        <span>💡</span>
        <div>
          <strong>小提示</strong>
          <p>
            {topCategory?.count
              ? `${store.activeChild.name}在${rangeLabel}内「${topCategory.name}」类任务上完成得最多，可以继续保持这个节奏。`
              : `${store.activeChild.name}在${rangeLabel}内还没有确认完成的任务，完成后这里会出现成长洞察。`}
          </p>
        </div>
      </section>
    </div>
  );
}
