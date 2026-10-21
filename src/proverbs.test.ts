import { describe, expect, it } from "vitest";
import { proverbForDate, proverbs } from "./proverbs";

describe("proverbs", () => {
  it("annotates every character with one aligned pinyin token", () => {
    for (const proverb of proverbs) {
      const chars = [...proverb.text];
      const tokens = proverb.pinyin.split(" ");
      expect(tokens, proverb.text).toHaveLength(chars.length);
    }
  });

  it("leaves punctuation unannotated", () => {
    for (const proverb of proverbs) {
      const chars = [...proverb.text];
      const tokens = proverb.pinyin.split(" ");
      chars.forEach((char, index) => {
        if (tokens[index] === char) return;
        // 标点必须用自己占位；反过来，汉字必须真的有一个读音。
        expect("，。！？".includes(char), `${proverb.text} 的第 ${index} 个字符`).toBe(false);
      });
    }
  });

  it("gives every proverb a complete English line", () => {
    for (const proverb of proverbs) {
      expect(proverb.english.trim(), proverb.text).not.toBe("");
      expect(proverb.english, proverb.text).not.toBe(proverb.text);
      expect(proverb.english, proverb.text).toMatch(/[.?!]$/);
    }
  });

  it("picks the same proverb for a date, and a different one the next day", () => {
    const first = proverbForDate("2026-10-14");
    expect(proverbForDate("2026-10-14")).toBe(first);
    expect(proverbForDate("2026-10-15")).not.toBe(first);
  });

  it("cycles through every proverb", () => {
    const seen = new Set<string>();
    for (let day = 0; day < proverbs.length; day += 1) {
      const [year, month, date] = "2026-10-01".split("-").map(Number);
      const iso = new Date(Date.UTC(year, month - 1, date + day))
        .toISOString()
        .slice(0, 10);
      seen.add(proverbForDate(iso).text);
    }
    expect(seen.size).toBe(proverbs.length);
  });
});
