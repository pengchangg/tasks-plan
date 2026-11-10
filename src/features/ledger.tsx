import { useAppStore } from "../store";
import { familyDate, familyTime, shiftDate } from "../domain";
import { EmptyState, PageHeading, StarMark } from "../ui";
import type { Child, PointLedger } from "../types";

// 积分账本 feature：孩子端唯一的「积分从哪来、到哪去」视图。数据全部来自 /state
// 的 ledger 切片，服务端没有新端点；行结构复用家长端「最近动态」的 .activity-list，
// 所以两端看到的同一笔账长一样。

// 结余从服务端给的当前余额往回减，所以哪怕历史账目被勾掉过（作业取消完成会删
// ledger 行），最新那一笔的结余也一定等于屏幕上那个「我的积分」。
// entries 必须是服务端的 created_at 升序（最新在最后）。
function balancesAfter(child: Child, entries: PointLedger[]): Map<string, number> {
  const after = new Map<string, number>();
  let running = child.pointsBalance;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    after.set(entries[index].id, running);
    running -= entries[index].amount;
  }
  return after;
}

// 组头的日期标签：这里本地定义，不能从 App.tsx 导 dateText/monthDayText——
// feature → App 是反向依赖（循环 import）。
const groupLabel = (date: string, today: string) =>
  date === today
    ? "今天"
    : date === shiftDate(today, -1)
      ? "昨天"
      : `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

export function ChildLedger({ store }: { store: ReturnType<typeof useAppStore> }) {
  const { state, activeChild: child } = store;
  const today = familyDate(new Date().toISOString(), state.timezone);
  // 服务端按 created_at 升序返回；filter 产生的是新数组，所以对它 reverse 不会
  // 动到 state.ledger 本身。
  const entries = state.ledger.filter((item) => item.childId === child.id);
  const after = balancesAfter(child, entries);
  // 按家庭本地日分组：升序遍历再 unshift，组与组内条目都是最新在上。
  const groups: {
    date: string;
    income: number;
    expense: number;
    items: PointLedger[];
  }[] = [];
  for (const item of entries) {
    const date = familyDate(item.createdAt, state.timezone);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.items.push(item);
    else groups.push({ date, income: 0, expense: 0, items: [item] });
  }
  for (const group of groups) {
    for (const item of group.items) {
      if (item.amount > 0) group.income += item.amount;
      else group.expense += item.amount;
    }
  }
  return (
    <div className="content-wrap">
      <PageHeading title="积分账本" description="每一分努力，都记在这里。" />
      <div className="ledger-total">
        <span>我的积分</span>
        <strong>{child.pointsBalance}</strong>
        <small>{`共 ${entries.length} 笔记录`}</small>
      </div>
      {entries.length === 0 ? (
        <EmptyState
          icon={<StarMark size={22} />}
          title="还没有积分记录"
          text="完成一个任务或一次作业，第一笔积分就会出现在这里"
        />
      ) : (
        groups
          .slice()
          .reverse()
          .map((group) => (
            <div key={group.date}>
              <div className="ledger-day">
                <h3>{groupLabel(group.date, today)}</h3>
                <span>{`收入 +${group.income} · 支出 −${Math.abs(group.expense)}`}</span>
              </div>
              <div className="activity-list">
                {group.items.slice().reverse().map((item) => (
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
                        {familyTime(item.createdAt, state.timezone)}
                      </small>
                    </div>
                    <b
                      className={
                        item.type === "earned" ? "positive" : "negative"
                      }
                    >
                      {item.amount > 0 ? "+" : ""}
                      {item.amount}
                    </b>
                    <small className="ledger-after">
                      结余 {after.get(item.id)}
                    </small>
                  </div>
                ))}
              </div>
            </div>
          ))
      )}
    </div>
  );
}
