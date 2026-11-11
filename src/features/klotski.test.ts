import { describe, expect, it } from "vitest";
import { applyMove, emptyKeys, isSolved, parseRows, pieceIcons, pieceLabels, solveFrom, stepToMove, targetsFor } from "./klotski";

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

  it("gives every piece a distinct emoji icon", () => {
    expect(pieceIcons.C).toBe("👑");
    expect(pieceIcons.G).toBe("🎭");
    // 四个卒面孔互不相同：孩子端一眼分得清。
    expect(new Set(["p", "q", "r", "s"].map((ch) => pieceIcons[ch])).size).toBe(4);
  });
});

describe("华容道提示", () => {
  it("numbers the two empty cells row-major and re-numbers after a slide", () => {
    // 开局空格 (3,1)(3,2)：行主序 → 1、2。
    expect(emptyKeys(hengdao)).toEqual({ "3,1": 1, "3,2": 2 });
    // q 滑进 (3,1) 后空格换到 (3,2)(4,1)，编号跟着重排。
    expect(emptyKeys(applyMove(hengdao, "q", [3, 1]))).toEqual({ "3,2": 1, "4,1": 2 });
  });

  it("solves 横刀立马 in the server floor of 118 steps with replayable steps", () => {
    const hint = solveFrom(hengdao);
    expect(hint).not.toBeNull();
    // 118 = 服务端 klotskiFloors()[1]，口径必须一致（完成接口按同一个数收下步数）。
    expect(hint!.moves).toBe(118);
    expect(hint!.steps).toHaveLength(118);
    expect(hint!.steps.every((step) => /^空[12](上|下|左|右)$/.test(step))).toBe(true);
    // 逐步重放：按当时局面的空格编号把记法翻回真实滑动，每步都必须是合法走法，
    // 且棋子确实落进记法点名的那个空格、确实朝记法说的方向挪了——记号翻译一旦
    // 反了方向或错认了棋子，这里当场失败。
    let cur = hengdao;
    const dirOf: Record<string, [number, number]> = { 上: [-1, 0], 下: [1, 0], 左: [0, -1], 右: [0, 1] };
    for (const step of hint!.steps) {
      const [, key, name] = /^空([12])([上下左右])$/.exec(step)!;
      const [dr, dc] = dirOf[name];
      const [er, ec] = Object.entries(emptyKeys(cur))
        .find(([, n]) => String(n) === key)!
        [0]
        .split(",")
        .map(Number);
      // 记法说的是「挨着空N的那块棋子朝它滑一格」：来源格 = 空格反向一格。
      const source = `${er - dr},${ec - dc}`;
      const piece = parseRows(cur).pieces.find((item) =>
        item.cells.some(([r, c]) => `${r},${c}` === source),
      )!;
      expect(piece).toBeTruthy();
      // applyMove 的 to 是锚点新位（老锚点 + 方向），不是被填进的空格。
      const to: [number, number] = [piece.cells[0][0] + dr, piece.cells[0][1] + dc];
      expect(targetsFor(cur, piece.char).some(([r, c]) => r === to[0] && c === to[1])).toBe(true);
      const moved = applyMove(cur, piece.char, to);
      expect(moved[er][ec]).toBe(piece.char);
      cur = moved;
    }
    expect(isSolved(cur)).toBe(true);
  });

  it("reports a won position as zero steps", () => {
    // 曹操已在出口 (3,1)(3,2)(4,1)(4,2)：不再需要任何一步。
    const solvedBoard = ["ADEB", "ADEB", "GGpq", "rCCs", ".CC."];
    expect(isSolved(solvedBoard)).toBe(true);
    expect(solveFrom(solvedBoard)).toEqual({ moves: 0, steps: [] });
  });

  it("names the first step with the hand-checked notation of a legal slide", () => {
    // q 已占 (3,1)，空格 (3,2)=空1、(4,1)=空2；此刻全盘只有三块能动、共五条合法
    // 滑动，第一步必是其一：r 上滑进空1 / r 左滑进空2、q 右滑进空1 / q 下滑进空2、
    // p 右滑进空2。手推的记号若与引擎相反（方向或空格错位），集合当场对不上。
    const board = ["ACCB", "ACCB", "DGGE", "Dq.E", "p.rs"];
    expect(targetsFor(board, "r")).toEqual([
      [3, 2],
      [4, 1],
    ]);
    expect(targetsFor(board, "q")).toEqual([
      [4, 1],
      [3, 2],
    ]);
    expect(targetsFor(board, "p")).toEqual([[4, 1]]);
    const hint = solveFrom(board);
    expect(hint).not.toBeNull();
    // 开局 118 步，q 已替孩子走过一步：最少还需恰好 117。
    expect(hint!.moves).toBe(117);
    expect(["空1上", "空1右", "空2下", "空2左", "空2右"]).toContain(hint!.steps[0]);
  });

  it("translates a notation step back to the piece and cell the board highlights", () => {
    // 开局第一句记法必须翻回一次真实滑动：棋子合法地滑进它点名的那格。
    const hint = solveFrom(hengdao)!;
    const move = stepToMove(hengdao, hint.steps[0]);
    expect(move).not.toBeNull();
    expect(targetsFor(hengdao, move!.char).some(([r, c]) => r === move!.anchor[0] && c === move!.anchor[1])).toBe(true);
    expect(applyMove(hengdao, move!.char, move!.anchor)[move!.cell[0]][move!.cell[1]]).toBe(move!.char);
    // 方向 = 锚点位移，界面箭头徽标就按它转。
    const piece = parseRows(hengdao).pieces.find((item) => item.char === move!.char)!;
    expect(move!.anchor[0] - piece.cells[0][0]).toBe(move!.dir[0]);
    expect(move!.anchor[1] - piece.cells[0][1]).toBe(move!.dir[1]);
    // 中盘的每个候选记号都各自落回各自合法的那块棋子。
    const board = ["ACCB", "ACCB", "DGGE", "Dq.E", "p.rs"];
    for (const step of ["空1上", "空1右", "空2下", "空2左", "空2右"]) {
      const m = stepToMove(board, step);
      expect(m, step).not.toBeNull();
      expect(targetsFor(board, m!.char).some(([r, c]) => r === m!.anchor[0] && c === m!.anchor[1])).toBe(true);
    }
    // 畸形记法不猜：编号越界、方向不认识都回 null。
    expect(stepToMove(hengdao, "空3上")).toBeNull();
    expect(stepToMove(hengdao, "空1斜")).toBeNull();
  });

  it("refuses malformed boards instead of guessing", () => {
    expect(solveFrom([])).toBeNull();
    expect(solveFrom(["....", "....", "....", "....", "...."])).toBeNull();
  });
});
