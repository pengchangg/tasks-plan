// 二年级两个轻游戏的纯生成器：口算闯关（60 秒速算）与找规律（10 题序列填空）。
// 题目全部在这里按种子随机生成（mulberry32），服务端只收成绩——信任级别同华容道
// 上报的步数。种子随机是为了测试可回放：同一颗种子必须发同一局题。

export type CalcOp = "+" | "-" | "×" | "÷";

// CalcProblem 是一道口算题。答案不进字符串，测试拿 left/right/op 自己算一遍。
export interface CalcProblem {
  left: number;
  right: number;
  op: CalcOp;
  answer: number;
  choices: number[];
}

// 难度阶梯：T1 20 以内加减；T2 100 以内加减（强制进位/退位各占一半）；
// T3 表内乘除速算。
export const CALC_TIERS = [1, 2, 3] as const;
export const PATTERN_LEVELS = [1, 2, 3] as const;
export const PATTERN_QUESTIONS = 10;

// mulberry32：32 位种子的确定性伪随机。仅用于出题，不碰任何真实奖励。
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng: () => number, low: number, high: number) =>
  low + Math.floor(rng() * (high - low + 1));

// shuffleInPlace 用 Fisher-Yates 打乱候选（rng 驱动，同种子同序）。
function shuffle<T>(rng: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// fourChoices 从 correct 与候选池里凑 4 个互不相同的选项（候选不足时放宽再补，
// 永远包含正确答案）。二年级的干扰项要「像算错」：±1、±2、加当减、忘进位。
function fourChoices(
  rng: () => number,
  correct: number,
  candidates: number[],
): number[] {
  const pool: number[] = [];
  for (const value of candidates)
    if (value >= 0 && value !== correct && !pool.includes(value))
      pool.push(value);
  // 保底补齐：真算错的样子都凑不出 4 个时，用 ±步长往外扩。
  let step = 1;
  while (pool.length < 3) {
    for (const offset of [step, -step]) {
      const value = correct + offset;
      if (value >= 0 && value !== correct && !pool.includes(value))
        pool.push(value);
    }
    step += 1;
  }
  const decoys = shuffle(rng, pool).slice(0, 3);
  return shuffle(rng, [...decoys, correct]);
}

// makeCalcProblem 按当前档位出一道题。T2 的一半题强制个位进位/退位——「100 以内
// 加减（含退位）」的重点就是它，纯 30+40 这种不叫练习叫抄答案。
export function makeCalcProblem(
  rng: () => number,
  tier: number,
): CalcProblem {
  if (tier >= 3) {
    // 表内乘除：口诀 2..9 相乘，除法用同一个积反推，商恒为整数。
    const a = pick(rng, 2, 9);
    const b = pick(rng, 2, 9);
    const product = a * b;
    if (rng() < 0.5)
      return {
        left: a,
        right: b,
        op: "×",
        answer: product,
        choices: fourChoices(rng, product, [
          a * (b + 1),
          a * (b - 1),
          product + a,
          product - a,
          product + b,
          product + 1,
        ]),
      };
    return {
      left: product,
      right: a,
      op: "÷",
      answer: b,
      choices: fourChoices(rng, b, [
        b + 1,
        b - 1,
        a,
        b + a,
        b + 2,
        Math.max(1, b - 2),
      ]),
    };
  }
  const limit = tier === 1 ? 20 : 100;
  const needCarry = tier === 2 && rng() < 0.5;
  const wantAdd = rng() < 0.5;
  if (wantAdd) {
    let left = pick(rng, tier === 1 ? 2 : 12, tier === 1 ? 18 : 88);
    let right: number;
    if (needCarry) {
      // 进位加：个位之和 ≥ 10。left 个位为 0 时进不了位，挪 1。
      if (left % 10 === 0) left -= 1;
      const l = left % 10; // 1..9
      right = 10 - l + pick(rng, 0, Math.min(4, l - 1)); // 个位 ≥ 10-l，且 ≤ 9
      right = Math.max(2, right); // l=9 时公式给 1..5，太小的题抬到 2 仍进位
    } else right = pick(rng, 2, tier === 1 ? limit - left : Math.min(89, limit - left));
    const answer = left + right;
    return {
      left,
      right,
      op: "+",
      answer,
      choices: fourChoices(rng, answer, [
        answer + 1,
        answer - 1,
        answer + 10,
        answer - 10,
        left + right - 2,
      ]),
    };
  }
  let left = pick(rng, tier === 1 ? 2 : 12, tier === 1 ? 18 : 88);
  let right: number;
  if (needCarry) {
    // 退位减：右个位 > 左个位。左个位为 9 时挪 1（进不了位）。
    if (left % 10 === 9) left += 1;
    const l = left % 10; // 0..8
    const ones = pick(rng, l + 1, 9);
    const maxTens = Math.max(0, Math.floor((left - ones) / 10));
    right = ones + 10 * pick(rng, 0, maxTens);
    if (right < 2) right += 10; // l=0 且 ones=1 时唯一可能；left≥12 抬得起
  } else right = pick(rng, 2, Math.min(left, limit));
  const answer = left - right;
  return {
    left,
    right,
    op: "-",
    answer,
    choices: fourChoices(rng, answer, [
      answer + 1,
      answer - 1,
      answer + 10,
      answer - 10,
      left + right,
    ]),
  };
}

// 找规律 L1 的图形池：二年级认识的一排简单图形。
const SHAPES = ["△", "○", "□", "☆", "◇", "✿"] as const;

// PatternItem 是一题：display 是已给出的序列（末尾是问号），answer/choices 是
// 填空的候选（字符串，数字也按字符串存——图形题与数字题共用一个渲染路径）。
export interface PatternItem {
  level: number;
  display: string[];
  answer: string;
  choices: string[];
}

// makePatternRound 发固定阶梯的一局：1-4 题周期循环、5-7 题等差、8-10 题两步
// 规律（增量递增 / 翻倍）。题目之间不复用同一图形池或同一等差。
export function makePatternRound(rng: () => number): PatternItem[] {
  const items: PatternItem[] = [];
  for (let i = 0; i < 4; i++) {
    // L1 周期：周期 2 或 3，每题从洗过的图形池取前 cycle 个（题间池自然不同）。
    const cycle = pick(rng, 2, 3);
    const palette = shuffle(rng, [...SHAPES]).slice(0, cycle);
    const seq: string[] = [];
    for (let n = 0; n < 5; n++) seq.push(palette[n % cycle]);
    const answer = palette[5 % cycle];
    const decoys = shuffle(
      rng,
      SHAPES.filter((shape) => !palette.includes(shape)),
    ).slice(0, 2);
    // 周期内的另外两个图形当第三个干扰项：孩子没看准周期就会选它们。
    const inCycle = palette.filter((shape) => shape !== answer);
    const choices = shuffle(rng, [answer, ...decoys, inCycle[0] ?? palette[0]]);
    items.push({
      level: 1,
      display: [...seq, "?"],
      answer,
      choices: [...new Set(choices)].slice(0, 4),
    });
  }
  const stepsUsed: number[] = [];
  for (let i = 0; i < 3; i++) {
    // L2 等差：公差 2..9（避开本局已用的），一半是递减。
    let step = pick(rng, 2, 9);
    while (stepsUsed.includes(step)) step = pick(rng, 2, 9);
    stepsUsed.push(step);
    const descending = rng() < 0.5;
    const first = descending
      ? pick(rng, step * 5 + 1, step * 5 + 30)
      : pick(rng, 1, 20);
    const seq: number[] = [];
    for (let n = 0; n < 5; n++)
      seq.push(descending ? first - n * step : first + n * step);
    const answer = descending ? first - 5 * step : first + 5 * step;
    items.push({
      level: 2,
      display: [...seq.map(String), "?"],
      answer: String(answer),
      choices: fourChoices(rng, answer, [
        answer + step,
        answer - step,
        answer + 1,
        answer + 2 * step,
      ]).map(String),
    });
  }
  for (let i = 0; i < 3; i++) {
    if (i < 2) {
      // L3a 增量递增：每次加的数自己也 +1（1, 3, 6, 10, 15, ?）。
      const first = pick(rng, 1, 8);
      const gap = pick(rng, 1, 4);
      const seq: number[] = [first];
      for (let n = 0; n < 4; n++) seq.push(seq[n] + gap + n);
      const answer = seq[4] + gap + 4;
      items.push({
        level: 3,
        display: [...seq.map(String), "?"],
        answer: String(answer),
        choices: fourChoices(rng, answer, [
          answer + gap + 5,
          answer - 1,
          answer + 1,
          seq[4] + gap + 3,
        ]).map(String),
      });
    } else {
      // L3b 翻倍：每次 ×2。
      const first = pick(rng, 2, 4);
      const seq = [first, first * 2, first * 4, first * 8, first * 16];
      const answer = first * 32;
      items.push({
        level: 3,
        display: [...seq.map(String), "?"],
        answer: String(answer),
        choices: fourChoices(rng, answer, [
          answer * 2,
          answer - first * 16,
          answer + first,
          first * 24,
        ]).map(String),
      });
    }
  }
  return items;
}
