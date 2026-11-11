import { describe, expect, it } from "vitest";
import { applyMove, isSolved, parseRows, pieceLabels, targetsFor } from "./klotski";

// 与 internal/server/games.go 的 klotskiLevels[1]「横刀立马」逐字一致的开局。
const hengdao = ["ACCB", "ACCB", "DGGE", "D..E", "pqrs"];

describe("klotski layout parsing", () => {
  it("groups same-char cells into one piece with kind and anchor", () => {
    const { pieces, empty } = parseRows(hengdao);
    expect(pieces).toHaveLength(10);
    const byChar = Object.fromEntries(pieces.map((piece) => [piece.char, piece]));
    expect(byChar.C.kind).toBe("caocao");
    expect(byChar.C.cells).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ]);
    expect(byChar.A.kind).toBe("vertical");
    expect(byChar.G.kind).toBe("guan");
    expect(byChar.G.cells).toEqual([
      [2, 1],
      [2, 2],
    ]);
    expect(byChar.p.kind).toBe("soldier");
    expect(byChar.p.cells).toEqual([[4, 0]]);
    expect(empty).toEqual([
      [3, 1],
      [3, 2],
    ]);
    // 排序按锚点行主序：A 的锚点 (0,0) 最先、四卒收尾。
    expect(pieces[0].char).toBe("A");
    expect(pieces.slice(-4).map((piece) => piece.char)).toEqual(["p", "q", "r", "s"]);
  });

  it("detects the win only when 曹操 sits in the bottom-centre exit", () => {
    // 出口是 (3,1)(3,2)(4,1)(4,2)：曹操要落到第 3/4 行的第 1/2 列。
    expect(isSolved(["....", "....", "....", ".CC.", ".CC."])).toBe(true);
    // 高一行不算赢；左右偏一格也不算。
    expect(isSolved(["....", "....", ".CC.", ".CC.", "...."])).toBe(false);
    expect(isSolved(["....", "....", "....", "CC..", "CC.."])).toBe(false);
  });
});

describe("klotski sliding", () => {
  it("lists anchors one cell away that stay in board and out of others", () => {
    // D 竖将占 (2,0)+(3,0)：上滑被 G 拦、下滑出不了卒行以外的路（(4,0)=p），
    // 右滑的新格 (2,1)=G/(3,1)='.' 混布也拦下 → D 完全动不了。
    expect(targetsFor(hengdao, "D")).toEqual([]);
    // 中央两个空格：q 卒 (4,1)、r 卒 (4,2) 各可上滑一格；p、s 被邻卒与边行围死。
    expect(targetsFor(hengdao, "q")).toEqual([[3, 1]]);
    expect(targetsFor(hengdao, "r")).toEqual([[3, 2]]);
    expect(targetsFor(hengdao, "p")).toEqual([]);
    expect(targetsFor(hengdao, "s")).toEqual([]);
    // 曹操 (0,1)..(1,2)：下 (2,1)=G 拦、右 (0,3)=B 拦、左 (0,0)=A 拦 → 只能上？上出界。
    expect(targetsFor(hengdao, "C")).toEqual([]);
    // 关羽 (2,1)+(2,2)：上 (1,1)=C 拦、左 D 右 E 拦，只剩 (3,1)/(3,2) 两个空格 → 恰好可下滑。
    expect(targetsFor(hengdao, "G")).toEqual([[3, 1]]);
  });

  it("applies a slide immutably and returns the new rows", () => {
    const moved = applyMove(hengdao, "q", [3, 1]);
    expect(moved).toEqual(["ACCB", "ACCB", "DGGE", "Dq.E", "p.rs"]);
    // 原数组一字未动，撤销因此只需要弹回历史栈。
    expect(hengdao).toEqual(["ACCB", "ACCB", "DGGE", "D..E", "pqrs"]);
    // 滑回原位后盘面与开局逐格相同。
    expect(applyMove(moved, "q", [4, 1])).toEqual(hengdao);
  });

  it("labels every piece with its Chinese face", () => {
    expect(pieceLabels.C).toBe("曹");
    expect(pieceLabels.G).toBe("羽");
    expect(pieceLabels.s).toBe("卒");
  });
});
