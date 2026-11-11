// 华容道引擎：纯函数，盘面就是服务端下发的 rows（5 行 × 4 字符）。同字符聚为一子：
// C×4=曹操 2×2，G×2=关羽 1×2（横），A/B/D/E 各两格上下=竖将 1×2，p/q/r/s 各自一格=卒。
// 胜利条件：曹操落到 (3,1)(3,2)(4,1)(4,2)（底行正中，出口）。

export type PieceKind = "caocao" | "vertical" | "guan" | "soldier";

export interface Piece {
  kind: PieceKind;
  char: string;
  cells: [number, number][];
}

export type Cell = [number, number];

// pieceLabels 是棋子字符到汉字面的映射：竖将用固定人名首字，关羽简称「羽」，四个卒同字。
export const pieceLabels: Record<string, string> = {
  C: "曹",
  A: "飞",
  B: "云",
  D: "超",
  E: "忠",
  G: "羽",
  p: "卒",
  q: "卒",
  r: "卒",
  s: "卒",
};

const verticalChars: Record<string, boolean> = { A: true, B: true, D: true, E: true };

// parseRows 把 rows 聚成棋子与空格。同一字母的每一格都属于同一子，服务端布局保证
// C 是 2×2、G 是横 1×2、竖将是上下 1×2；左上格（行列最小者）即锚点。
export function parseRows(rows: string[]): { pieces: Piece[]; empty: Cell[] } {
  const byChar: Record<string, Cell[]> = {};
  const empty: Cell[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const ch = rows[r][c];
      if (ch === ".") {
        empty.push([r, c]);
        continue;
      }
      (byChar[ch] ??= []).push([r, c]);
    }
  }
  const pieces: Piece[] = [];
  for (const ch of Object.keys(byChar)) {
    const cells = byChar[ch].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const kind: PieceKind =
      ch === "C"
        ? "caocao"
        : ch === "G"
          ? "guan"
          : verticalChars[ch]
            ? "vertical"
            : "soldier";
    pieces.push({ kind, char: ch, cells });
  }
  pieces.sort((a, b) => a.cells[0][0] - b.cells[0][0] || a.cells[0][1] - b.cells[0][1]);
  return { pieces, empty };
}

// targetsFor 给出某个棋子的合法滑动目标：四个方向各滑一格，滑进的新格要么本来就是
// 这个子自己的、要么是空格，且不出盘。返回的是该子左上锚点的新位置。
export function targetsFor(rows: string[], char: string): Cell[] {
  const { pieces } = parseRows(rows);
  const piece = pieces.find((item) => item.char === char);
  if (!piece) return [];
  const targets: Cell[] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    let ok = true;
    for (const [r, c] of piece.cells) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > 4 || nc < 0 || nc > 3) {
        ok = false;
        break;
      }
      const mine = piece.cells.some(([pr, pc]) => pr === nr && pc === nc);
      if (!mine && rows[nr][nc] !== ".") {
        ok = false;
        break;
      }
    }
    if (ok) targets.push([piece.cells[0][0] + dr, piece.cells[0][1] + dc]);
  }
  return targets;
}

// applyMove 把某个子滑到以 to 为左上锚点的新位置，返回新 rows（原数组不变，所以
// 撤销就是弹回历史栈里的那份）。
export function applyMove(rows: string[], char: string, to: Cell): string[] {
  const { pieces } = parseRows(rows);
  const piece = pieces.find((item) => item.char === char);
  if (!piece) return rows;
  const grid: string[][] = rows.map((row) => [...row]);
  for (const [r, c] of piece.cells) grid[r][c] = ".";
  const [ar, ac] = piece.cells[0];
  const [dr, dc] = [to[0] - ar, to[1] - ac];
  for (const [r, c] of piece.cells) grid[r + dr][c + dc] = char;
  return grid.map((row) => row.join(""));
}

// isSolved 只看曹操是否落到底行正中：(3,1)(3,2)(4,1)(4,2) 全是 C。
export function isSolved(rows: string[]): boolean {
  return rows[3]?.[1] === "C" && rows[3]?.[2] === "C" && rows[4]?.[1] === "C" && rows[4]?.[2] === "C";
}
