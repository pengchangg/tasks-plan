import { describe, expect, it } from "vitest";
import {
  holidayNameOf,
  lunarFestival,
  lunarLabel,
  lunarMonthDay,
  lunarOf,
  restMark,
} from "./lunar";
import type { HolidaySpan } from "./types";

const spans: HolidaySpan[] = [
  { name: "春节", start: "2026-02-15", end: "2026-02-23" },
  { name: "国庆节", start: "2026-10-01", end: "2026-10-07" },
];
const makeup = ["2026-02-14", "2026-10-10"];

describe("农历与休假角标", () => {
  it("正月初一是春节，除夕按次日倒推", () => {
    expect(lunarOf("2026-02-17")).toEqual({
      month: "正月",
      day: 1,
      dayText: "初一",
      leap: false,
    });
    expect(lunarFestival("2026-02-17")).toBe("春节");
    expect(lunarFestival("2026-02-16")).toBe("除夕");
    expect(lunarLabel("2026-09-25")).toBe("中秋节");
    expect(lunarMonthDay("2026-10-23")).toBe("九月十四");
  });

  it("闰月照 ICU 的原名返回，但不当成节日", () => {
    const leap = lunarOf("2025-07-25");
    expect(leap.leap).toBe(true);
    expect(leap.month).toBe("六月");
    expect(lunarMonthDay("2025-07-25")).toBe("闰六月初一");
    expect(lunarLabel("2025-07-25")).toBe("初一");
  });

  it("官方区间与调休上班日的角标互补", () => {
    expect(restMark("2026-10-03", spans, makeup)).toBe("休");
    expect(restMark("2026-10-10", spans, makeup)).toBe("班");
    expect(restMark("2026-10-11", spans, makeup)).toBe("休");
    expect(restMark("2026-10-09", spans, makeup)).toBe("");
    expect(holidayNameOf("2026-10-03", spans)).toBe("国庆节");
  });
});
