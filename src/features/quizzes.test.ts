import { describe, expect, it } from "vitest";
import {
  CALC_TIERS,
  PATTERN_QUESTIONS,
  makeCalcProblem,
  makePatternRound,
  rngFrom,
} from "./quizzes";

// 种子随机必须可回放：同种子同题，否则这些断言就成了碰运气。
describe("口算题生成", () => {
  it("同一种子发同一局题，不同种子大概率不同", () => {
    const a = makeCalcProblem(rngFrom(42), 1);
    const b = makeCalcProblem(rngFrom(42), 1);
    expect(a).toEqual(b);
    expect(makeCalcProblem(rngFrom(7), 1)).not.toEqual(a);
  });

  it("每一档的答案都真的对，选项去重且含答案", () => {
    for (const tier of CALC_TIERS) {
      const rng = rngFrom(1000 + tier);
      for (let n = 0; n < 200; n++) {
        const p = makeCalcProblem(rng, tier);
        const computed =
          p.op === "+"
            ? p.left + p.right
            : p.op === "-"
              ? p.left - p.right
              : p.op === "×"
                ? p.left * p.right
                : p.left / p.right;
        expect(p.answer).toBe(computed);
        expect(Number.isInteger(p.answer)).toBe(true);
        expect(p.answer).toBeGreaterThanOrEqual(0);
        expect(p.choices).toHaveLength(4);
        expect(new Set(p.choices).size).toBe(4);
        expect(p.choices).toContain(p.answer);
        for (const c of p.choices) expect(c).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("T1 和不超过 20，T2 不超 100，T3 是表内乘除", () => {
    const rng1 = rngFrom(11);
    for (let n = 0; n < 200; n++) {
      const p = makeCalcProblem(rng1, 1);
      expect(p.answer).toBeLessThanOrEqual(20);
      if (p.op === "+" || p.op === "-")
        expect(Math.max(p.left, p.right)).toBeLessThan(20);
    }
    const rng2 = rngFrom(22);
    for (let n = 0; n < 200; n++) expect(makeCalcProblem(rng2, 2).answer).toBeLessThanOrEqual(100);
    const rng3 = rngFrom(33);
    for (let n = 0; n < 200; n++) {
      const p = makeCalcProblem(rng3, 3);
      expect(["×", "÷"]).toContain(p.op);
      if (p.op === "×") {
        expect(p.left).toBeGreaterThanOrEqual(2);
        expect(p.left).toBeLessThanOrEqual(9);
        expect(p.right).toBeGreaterThanOrEqual(2);
        expect(p.right).toBeLessThanOrEqual(9);
      } else {
        expect(p.left % p.right).toBe(0); // 除法商恒为整数
      }
    }
  });

  it("T2 一半的题真的进位/退位", () => {
    const rng = rngFrom(404);
    let carryAdd = 0;
    let borrowSub = 0;
    let special = 0;
    for (let n = 0; n < 200; n++) {
      const p = makeCalcProblem(rng, 2);
      if (p.op === "+") {
        if ((p.left % 10) + (p.right % 10) >= 10) carryAdd++;
        special++;
      } else if (p.op === "-") {
        if (p.left % 10 < p.right % 10) borrowSub++;
        special++;
      }
    }
    expect(special).toBeGreaterThan(0);
    expect(carryAdd + borrowSub).toBeGreaterThanOrEqual(special * 0.4);
  });
});

describe("找规律出题", () => {
  it("固定阶梯 4+3+3，共 10 题，答案都在选项里且问号在末尾", () => {
    const items = makePatternRound(rngFrom(9));
    expect(items).toHaveLength(PATTERN_QUESTIONS);
    expect(items.map((item) => item.level)).toEqual([
      1, 1, 1, 1, 2, 2, 2, 3, 3, 3,
    ]);
    for (const item of items) {
      expect(item.display[item.display.length - 1]).toBe("?");
      expect(item.choices).toContain(item.answer);
      expect(new Set(item.choices).size).toBe(item.choices.length);
    }
  });

  it("L1 序列按周期循环且答案延续周期", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const items = makePatternRound(rngFrom(seed * 991)).filter((i) => i.level === 1);
      for (const item of items) {
        const seq = item.display.slice(0, -1);
        for (const cycle of [2, 3]) {
          const head = seq.slice(0, cycle);
          if (seq.every((value, index) => value === head[index % cycle])) {
            expect(item.answer).toBe(head[5 % cycle]);
            break;
          }
        }
      }
    }
  });

  it("L2 是等差且答案延续公差；L3 延续增量递增或翻倍", () => {
    const items = makePatternRound(rngFrom(777));
    for (const item of items.filter((i) => i.level === 2)) {
      const seq = item.display.slice(0, -1).map(Number);
      const step = seq[1] - seq[0];
      expect(step).not.toBe(0);
      expect(seq.every((value, index) => value === seq[0] + step * index)).toBe(true);
      expect(Number(item.answer)).toBe(seq[4] + step);
    }
    for (const item of items.filter((i) => i.level === 3)) {
      const seq = item.display.slice(0, -1).map(Number);
      const answer = Number(item.answer);
      const gaps = [1, 2, 3, 4].map((n) => seq[n] - seq[n - 1]);
      const growing = gaps.every((gap, n) => gap === gaps[0] + n);
      const doubling = gaps.every((gap, n) => gap === seq[0] * 2 ** n);
      expect(growing || doubling).toBe(true);
      expect(answer).toBe(growing ? seq[4] + gaps[0] + 4 : seq[4] * 2);
    }
  });

  it("同种子回放同一局", () => {
    expect(makePatternRound(rngFrom(55))).toEqual(makePatternRound(rngFrom(55)));
  });
});
