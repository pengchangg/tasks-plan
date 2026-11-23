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

// pieceLabels 是棋子字符到汉字面的映射：武将写全名，四个卒同字。
export const pieceLabels: Record<string, string> = {
  C: "曹操",
  A: "张飞",
  B: "赵云",
  D: "马超",
  E: "黄忠",
  G: "关羽",
  p: "卒",
  q: "卒",
  r: "卒",
  s: "卒",
};

// pieceIcons 是棋子字符到 emoji 面孔的映射（与 pieceLabels 同层的纯 UI 装饰）：
// 每个棋子面孔互不相同，四个卒靠孩子端棋盘上的汉字面仍可辨（都是「卒」）。
export const pieceIcons: Record<string, string> = {
  C: "👑",
  A: "🗡",
  B: "🔥",
  D: "🐎",
  E: "🏹",
  G: "🎭",
  p: "🚩",
  q: "🛡",
  r: "🎯",
  s: "🏮",
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

// emptyKeys 按行主序给两个空格编号 1、2（key = "r,c"）：提示文案用编号称呼空格，
// 每次滑动之后都要用当时的局面重新编号——记法和孩子在棋盘上看到的编号永远一致。
export function emptyKeys(rows: string[]): Record<string, 1 | 2> {
  const keys: Record<string, 1 | 2> = {};
  let n: 1 | 2 = 1;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== ".") continue;
      keys[`${r},${c}`] = n;
      n = n === 1 ? 2 : 1;
    }
  }
  return keys;
}

export interface Hint {
  moves: number;
  steps: string[];
}

// HintMove 是记法翻回真实棋盘的结果：该动的棋子 + applyMove 要的锚点新位 +
// 方向（画箭头徽标用）+ 这一步填进的那格（画落点框用）。
export interface HintMove {
  char: string;
  anchor: Cell;
  dir: [number, number];
  cell: Cell;
}

// stepToMove 把某条记法（"空1上"）在**当时的局面**上落成一次真实滑动：空格编号
// 按行主序反查回格子，来源格 = 空格沿方向反向一格。记号翻译一旦反向或错认棋子，
// 界面高亮就会指错——vitest 的逐步重放钉住这里与 solveFrom 口径一致。
export function stepToMove(rows: string[], step: string): HintMove | null {
  const match = /^空([12])(上|下|左|右)$/.exec(step);
  if (!match) return null;
  const dir = stepDirs.find((item) => item.name === match[2])!;
  const keys = emptyKeys(rows);
  let cell: Cell | null = null;
  for (const [key, n] of Object.entries(keys))
    if (String(n) === match[1]) cell = key.split(",").map(Number) as Cell;
  if (!cell) return null;
  const [er, ec] = cell;
  const [dr, dc] = [dir.dr, dir.dc];
  const sr = er - dr;
  const sc = ec - dc;
  if (sr < 0 || sr > 4 || sc < 0 || sc > 3) return null;
  const ch = rows[sr]?.[sc];
  if (!ch || ch === ".") return null;
  const { pieces } = parseRows(rows);
  const piece = pieces.find((item) => item.char === ch);
  if (!piece) return null;
  const anchor: Cell = [piece.cells[0][0] + dr, piece.cells[0][1] + dc];
  if (!targetsFor(rows, ch).some(([r, c]) => r === anchor[0] && c === anchor[1])) return null;
  return { char: ch, anchor, dir: [dr, dc], cell };
}

const stepDirs = [
  { dr: -1, dc: 0, name: "上" },
  { dr: 1, dc: 0, name: "下" },
  { dr: 0, dc: -1, name: "左" },
  { dr: 0, dc: 1, name: "右" },
] as const;

// 同形组与去重键：竖将四个、卒四个形状相同，键里按落点排序归一（理由同服务端
// klotskiShortest——滑动合法性只看形状，可解性与最短步数都等价，状态空间从千万级
// 回到约 6.5 万）。路径存在真实局面的前驱表里，回构出来的每一步都是真棋子真滑动。
function encodeRows(rows: string[]): string | null {
  const { pieces } = parseRows(rows);
  const anchor: Record<string, number> = {};
  for (const piece of pieces) anchor[piece.char] = piece.cells[0][0] * 4 + piece.cells[0][1];
  for (const ch of "CABDEGpqrs") if (anchor[ch] === undefined) return null;
  const verticals = ["A", "B", "D", "E"].map((ch) => anchor[ch]).sort((a, b) => a - b);
  const soldiers = ["p", "q", "r", "s"].map((ch) => anchor[ch]).sort((a, b) => a - b);
  return [anchor["C"], ...verticals, anchor["G"], ...soldiers].join(",");
}

// solveFrom 对当前真实局面做广度优先搜索：最少还需几步 + 每步的记法
// （"空1上" = 挨着空1的那块棋子向它滑一格，与界面点圆点的走法一一对应）。
// 转移按空格生成（两个空格 × 四方向吸附），合法性镜像 targetsFor 的判定。
// 已解局面回 { moves: 0, steps: [] }；缺子的畸形盘面与无解回 null（内置关永不触发）。
export function solveFrom(rows: string[]): Hint | null {
  if (rows.length !== 5 || rows.some((row) => row.length !== 4)) return null;
  if (isSolved(rows)) return { moves: 0, steps: [] };
  const startKey = encodeRows(rows);
  if (startKey === null) return null;
  const start = rows.join("");
  const seen = new Set<string>([startKey]);
  const prev = new Map<string, { from: string; step: string }>();
  let frontier = [start];
  let dist = 0;
  while (frontier.length > 0) {
    dist += 1;
    const next: string[] = [];
    for (const board of frontier) {
      const cur = board.match(/.{4}/g) ?? [];
      const keys = emptyKeys(cur);
      const { pieces } = parseRows(cur);
      const empties: Cell[] = [];
      for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) if (cur[r][c] === ".") empties.push([r, c]);
      for (const [er, ec] of empties) {
        for (const dir of stepDirs) {
          // 滑进这个空格的那格（棋子的来源格）= 空格沿滑动方向的反向一格。
          const sr = er - dir.dr;
          const sc = ec - dir.dc;
          if (sr < 0 || sr > 4 || sc < 0 || sc > 3) continue;
          const ch = cur[sr][sc];
          if (ch === ".") continue;
          const piece = pieces.find((item) => item.char === ch);
          if (!piece) return null;
          const mine = new Set(piece.cells.map(([r, c]) => `${r},${c}`));
          let ok = true;
          for (const [r, c] of piece.cells) {
            const nr = r + dir.dr;
            const nc = c + dir.dc;
            if (nr < 0 || nr > 4 || nc < 0 || nc > 3 || (!mine.has(`${nr},${nc}`) && cur[nr][nc] !== ".")) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          const moved = applyMove(cur, ch, [piece.cells[0][0] + dir.dr, piece.cells[0][1] + dir.dc]);
          const nb = moved.join("");
          const key = encodeRows(moved);
          if (key === null || seen.has(key)) continue;
          seen.add(key);
          prev.set(nb, { from: board, step: `空${keys[`${er},${ec}`]}${dir.name}` });
          if (isSolved(moved)) {
            const steps: string[] = [];
            let node = nb;
            for (;;) {
              const edge = prev.get(node);
              if (!edge) break;
              steps.unshift(edge.step);
              node = edge.from;
            }
            return { moves: dist, steps };
          }
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return null;
}
