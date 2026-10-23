import { shiftDate } from "./domain";
import type { HolidaySpan } from "./types";

// 农历走平台自带的 ICU 中文历法（Intl 的 chinese 日历），零依赖、不发请求，
// 与浏览器/Node 用的是同一份 ICU 数据。日期是家庭本地 YYYY-MM-DD，所以固定按
// UTC 正午解析：用本地午夜会被时区推掉一天。
const format = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
});

const LUNAR_DAYS = [
  "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

export interface LunarDate {
  month: string;
  day: number;
  dayText: string;
  leap: boolean;
}

const cache = new Map<string, LunarDate>();

export function lunarOf(date: string): LunarDate {
  const hit = cache.get(date);
  if (hit) return hit;
  let month = "";
  let day = 1;
  for (const part of format.formatToParts(new Date(`${date}T12:00:00Z`))) {
    if (part.type === "month") month = part.value;
    else if (part.type === "day") day = Number(part.value);
  }
  const leap = month.startsWith("闰");
  const value: LunarDate = {
    month: leap ? month.slice(1) : month,
    day,
    dayText: LUNAR_DAYS[day - 1] ?? "",
    leap,
  };
  cache.set(date, value);
  return value;
}

// 农历节日写死「月+日」，闰月里的同一天不算（闰六月初六不是节日）。
const FESTIVALS: Record<string, string> = {
  "正月1": "春节",
  "正月15": "元宵节",
  "五月5": "端午节",
  "七月7": "七夕节",
  "八月15": "中秋节",
  "九月9": "重阳节",
  "腊月8": "腊八节",
};

// lunarFestival 返回当天的农历节日名（除夕按「次日是正月初一」倒推），没有节日就是空串。
export function lunarFestival(date: string): string {
  const lunar = lunarOf(date);
  if (!lunar.leap && FESTIVALS[`${lunar.month}${lunar.day}`]) {
    return FESTIVALS[`${lunar.month}${lunar.day}`];
  }
  const next = lunarOf(shiftDate(date, 1));
  if (!next.leap && next.month === "正月" && next.day === 1) return "除夕";
  return "";
}

// lunarLabel 是日历格子里的那行小字：有节日就写节日名，否则写农历日号。
export function lunarLabel(date: string): string {
  return lunarFestival(date) || lunarOf(date).dayText;
}

// lunarMonthDay 是标题里用的完整写法，如「九月十四」「闰六月初一」。
export function lunarMonthDay(date: string): string {
  const lunar = lunarOf(date);
  return `${lunar.leap ? "闰" : ""}${lunar.month}${lunar.dayText}`;
}

// restMark 是日历右上角的角标：调休上班日「班」，官方区间内或周末「休」。
// 周末按星期算，只有 Server 下发的调休上班日能把它翻回来。
export function restMark(
  date: string,
  holidays: HolidaySpan[],
  makeupWorkdays: string[],
): "休" | "班" | "" {
  if (makeupWorkdays.includes(date)) return "班";
  // 0 = 周日，6 = 周六；按 UTC 解析日期串，不受设备时区影响。
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return "休";
  const day = date;
  return holidays.some((span) => day >= span.start && day <= span.end) ? "休" : "";
}

export function holidayNameOf(date: string, holidays: HolidaySpan[]): string {
  return holidays.find((span) => date >= span.start && date <= span.end)?.name ?? "";
}
