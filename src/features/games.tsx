import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "../store";
import { EmptyState, PageHeading, ParentHeader, useDialog } from "../ui";
import { applyMove, isSolved, parseRows, pieceIcons, pieceLabels, solveFrom, targetsFor } from "./klotski";
import type { Cell, Hint, Piece } from "./klotski";
import type { KlotskiLevel } from "../types";

// 华容道 feature：孩子端关卡列表与棋盘、首页入口卡、家长端只读进度。布局与进度都
// 来自 store.klotski（GET /games/klotski），盘面推进是 src/features/klotski.ts 的纯函数。

// 竖将的汉字固定 A/B/D/E 四个字符对应，见 klotski.ts 的 pieceLabels。
const spanOf = (piece: Piece): [number, number] =>
  piece.kind === "caocao"
    ? [2, 2]
    : piece.kind === "vertical"
      ? [2, 1]
      : piece.kind === "guan"
        ? [1, 2]
        : [1, 1];

// describeStep 把引擎的记法（"空1上" = 挨着空1的棋子向它滑一格）翻成给孩子读的话
// （"空1 向上滑"）。空格编号跟着当时的局面走，所以列表里每步的编号各说各的时刻。
const describeStep = (step: string): string => {
  const match = /^空([12])([上下左右])$/.exec(step);
  if (!match) return step;
  return `空${match[1]} 向${match[2]}滑`;
};

export function GameTeaser({ store }: { store: ReturnType<typeof useAppStore> }) {
  return (
    <Link className="game-teaser" to="/child/games" aria-label="进入游戏">
      <span className="game-teaser-icon" aria-hidden="true">🧩</span>
      <div>
        <strong>华容道</strong>
        <span>已通关 {store.klotski.completed}/5</span>
      </div>
      <ChevronRight size={15} />
    </Link>
  );
}

export function ChildGames({ store }: { store: ReturnType<typeof useAppStore> }) {
  const navigate = useNavigate();
  if (store.klotski.levels.length === 0)
    return (
      <EmptyState
        icon="🧩"
        title="小游戏还没准备好"
        text="刷新页面或稍后再试一次。"
      />
    );
  return (
    <div className="content-wrap">
      <PageHeading title="小游戏" description="通关一关记一次 30 积分，每关只奖励第一次。" />
      <div className="game-grid">
        {store.klotski.levels.map((level) => (
          <button
            key={level.level}
            className={`game-card${level.unlocked ? "" : " locked"}`}
            disabled={!level.unlocked}
            onClick={() => navigate(`/child/games/klotski?level=${level.level}`)}
          >
            <span className="game-card-icon" aria-hidden="true">
              {level.unlocked ? "🧩" : "🔒"}
            </span>
            <strong>
              第{level.level}关 · {level.name}
            </strong>
            <span>
              {level.completed
                ? `已通关 · 最少 ${level.bestMoves} 步`
                : level.unlocked
                  ? "未通关"
                  : "先通关上一关"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function KlotskiGame({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [params] = useSearchParams();
  const levelNumber = Number(params.get("level"));
  const level = store.klotski.levels.find((item) => item.level === levelNumber);
  if (!level || !level.unlocked)
    return (
      <div className="content-wrap">
        <EmptyState
          icon="🔒"
          title="这一关还没解锁"
          text="从关卡列表选一关已经打开的来玩吧。"
        />
        <p className="klotski-back">
          <Link to="/child/games">
            <ChevronLeft size={14} /> 返回关卡列表
          </Link>
        </p>
      </div>
    );
  // key 只认关号：通关后 store 重拉会换掉 rows 对象，棋盘不该因此被重置。
  return <KlotskiBoard key={level.level} level={level} store={store} />;
}

function KlotskiBoard({
  level,
  store,
}: {
  level: KlotskiLevel;
  store: ReturnType<typeof useAppStore>;
}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<string[]>(level.rows);
  const [steps, setSteps] = useState(0);
  const [history, setHistory] = useState<string[][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // 通关上报只发一次；上报失败时放开，让孩子能按「重试领取」再试。
  const claimed = useRef(false);
  const [failed, setFailed] = useState(false);
  // +30 胶囊的所有权在本地（同 HomeworkDay）：只画服务端算出的 awarded。
  const [award, setAward] = useState<number | null>(null);
  const awardTimer = useRef(0);
  const [won, setWon] = useState(false);
  const [record, setRecord] = useState<number | null>(null);
  // 提示是对「当前真实局面」跑一遍 solveFrom 的结果：任何滑动/撤销/重置都会让它
  // 过时，所以那三处一起清掉；列表展开态跟着提示一起没了。
  const [hint, setHint] = useState<Hint | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  useEffect(() => () => window.clearTimeout(awardTimer.current), []);

  const solved = isSolved(rows);
  // 上报这一次胜利：服务端说首通才弹窗 + 画胶囊，说重放（awarded=0）就只留纪录话术。
  // 失败时 claimed 放开，孩子可以点「重试」再报一次，不会把胜利吞掉。
  const claim = () => {
    void (async () => {
      const awarded = await store.actions.completeKlotskiLevel(level.level, steps);
      if (awarded === undefined) {
        claimed.current = false;
        setFailed(true);
        return;
      }
      setFailed(false);
      if (awarded > 0) {
        setAward(awarded);
        awardTimer.current = window.setTimeout(() => setAward(null), 2000);
        setWon(true);
      } else if (level.completed && steps < level.bestMoves) {
        setRecord(steps);
      }
    })();
  };
  useEffect(() => {
    if (!solved || claimed.current) return;
    claimed.current = true;
    claim();
    // claim 只吃本次渲染的 steps，solved 翻真那一刻才是该上报的一次。
  }, [solved]);

  const reset = (next: string[]) => {
    claimed.current = false;
    setFailed(false);
    setWon(false);
    setRecord(null);
    setAward(null);
    setSelected(null);
    setHint(null);
    setShowSteps(false);
    setRows(next);
    setSteps(0);
    setHistory([]);
  };
  const replay = () => reset(level.rows);

  const move = (to: Cell) => {
    if (!selected) return;
    setHistory((prev) => [...prev, rows]);
    setRows(applyMove(rows, selected, to));
    setSteps((prev) => prev + 1);
    setSelected(null);
    setHint(null);
    setShowSteps(false);
  };
  const undo = () => {
    if (history.length === 0) return;
    setRows(history[history.length - 1]);
    setHistory((prev) => prev.slice(0, -1));
    setSteps((prev) => prev - 1);
    setSelected(null);
    setHint(null);
    setShowSteps(false);
  };
  // 提示永远贴着孩子当下的棋盘：现算，不缓存，走一步就作废。
  const askHint = () => {
    setHint(solveFrom(rows));
    setShowSteps(false);
  };

  const { pieces } = parseRows(rows);
  const selectedPiece = pieces.find((piece) => piece.char === selected);
  // 选中棋子后，把它滑一格能新占到的空格画成圆点；每个圆点记着自己属于哪次滑动
  // （anchor = 锚点新位，是 applyMove 真正需要的坐标），点圆点即滑动。
  const dots: { cell: Cell; anchor: Cell }[] = [];
  // blocked 集合让动不了的棋子灰掉：点了也不会有圆点，与其让孩子猜不如先说清。
  const blocked = new Set(
    pieces.filter((piece) => targetsFor(rows, piece.char).length === 0).map((piece) => piece.char),
  );
  if (selectedPiece) {
    const mine = new Set(selectedPiece.cells.map(([r, c]) => `${r},${c}`));
    for (const anchor of targetsFor(rows, selectedPiece.char)) {
      const [dr, dc] = [anchor[0] - selectedPiece.cells[0][0], anchor[1] - selectedPiece.cells[0][1]];
      for (const [r, c] of selectedPiece.cells) {
        const key = `${r + dr},${c + dc}`;
        if (!mine.has(key) && !dots.some((dot) => `${dot.cell[0]},${dot.cell[1]}` === key))
          dots.push({ cell: [r + dr, c + dc], anchor });
      }
    }
  }

  return (
    <div className="content-wrap">
      <p className="klotski-back">
        <Link to="/child/games">
          <ChevronLeft size={14} /> 返回关卡列表
        </Link>
      </p>
      <PageHeading title={`第${level.level}关 · ${level.name}`} description="点一块棋子，再点亮起的空位就能滑动。曹操走进底部出口就通关。" />
      <div className="klotski-board">
        {/* 出口在底行正中：曹操 2×2 走进虚线落区、从底边缺口出去就通关。落区画在
            棋子底层（曹操一到就被盖住，「堵住出口」看得见），缺口压在棋盘底边上。 */}
        <div className="klotski-exit">出口</div>
        <div className="klotski-exit-notch" aria-hidden="true" />
        {pieces.map((piece) => {
          const [rowsSpan, colsSpan] = spanOf(piece);
          const [r, c] = piece.cells[0];
          return (
            <button
              key={piece.char}
              type="button"
              data-piece={piece.char}
              className={`klotski-piece piece-${piece.kind}${selected === piece.char ? " selected" : ""}${blocked.has(piece.char) ? " piece-blocked" : ""}`}
              style={{
                gridColumnStart: c + 1,
                gridColumnEnd: `span ${colsSpan}`,
                gridRowStart: r + 1,
                gridRowEnd: `span ${rowsSpan}`,
              }}
              onClick={() => setSelected(selected === piece.char ? null : piece.char)}
            >
              <span className="piece-icon" aria-hidden="true">
                {pieceIcons[piece.char]}
              </span>
              <span className="piece-label">{pieceLabels[piece.char]}</span>
            </button>
          );
        })}
        {dots.map((dot) => (
          <button
            key={`${dot.cell[0]}-${dot.cell[1]}-${dot.anchor[0]}-${dot.anchor[1]}`}
            type="button"
            className="movable-target"
            data-anchor={`${dot.anchor[0]},${dot.anchor[1]}`}
            aria-label={`移动到第${dot.cell[0] + 1}行第${dot.cell[1] + 1}列`}
            style={{ gridColumnStart: dot.cell[1] + 1, gridRowStart: dot.cell[0] + 1 }}
            onClick={() => move(dot.anchor)}
          />
        ))}
      </div>
      <div className="klotski-toolbar">
        <button className="outline-button" onClick={undo} disabled={history.length === 0}>
          撤销
        </button>
        <button className="outline-button" onClick={replay}>
          重置
        </button>
        <button className="outline-button" onClick={askHint} disabled={level.completed}>
          提示
        </button>
        <span className="klotski-steps">
          第 {steps} 步 / 最少 {level.minMoves} 步
        </span>
        {award !== null && (
          <span className="klotski-award" aria-hidden="true">
            +{award}
          </span>
        )}
      </div>
      {hint !== null &&
        (hint.moves === 0 ? (
          <p className="klotski-hint" role="status">
            曹操已经堵住出口，<mark>再向下滑一格</mark>就通关。
          </p>
        ) : (
          <>
            <p className="klotski-hint" role="status">
              下一步：<mark>{describeStep(hint.steps[0])}</mark>（最少还需 {hint.moves} 步）
            </p>
            <button className="klotski-hint-more" onClick={() => setShowSteps((prev) => !prev)}>
              {showSteps ? "收起走法" : "看完整走法"}
            </button>
            {showSteps && (
              <ol className="klotski-steps-list">
                {hint.steps.map((step, index) => (
                  <li key={index}>{describeStep(step)}</li>
                ))}
              </ol>
            )}
          </>
        ))}
      {record !== null && !won && (
        <p className="klotski-record">刷新纪录：{record} 步（每关只有第一次通关记积分）</p>
      )}
      {failed && solved && (
        <button className="klotski-retry" onClick={claim}>
          通关奖励领取失败，点击重试
        </button>
      )}
      {won && (
        <WinModal
          level={level}
          steps={steps}
          onReplay={replay}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}

// 通关弹窗单独成组件：useDialog 的焦点陷阱要跟着弹窗一起挂载才绑得上。
function WinModal({
  level,
  steps,
  onReplay,
  onNavigate,
}: {
  level: KlotskiLevel;
  steps: number;
  onReplay: () => void;
  onNavigate: (to: string) => void;
}) {
  const dialog = useDialog(onReplay);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="通关成功">
        <div className="modal-icon">🎉</div>
        <h2>通关成功</h2>
        <p>「{level.name}」用了 {steps} 步，奖励 30 积分已经到账。</p>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onReplay}>
            再玩一次
          </button>
          {level.level < 5 ? (
            <button
              className="wide-primary"
              onClick={() => onNavigate(`/child/games/klotski?level=${level.level + 1}`)}
            >
              下一关
            </button>
          ) : (
            <button className="wide-primary" onClick={() => onNavigate("/child/games")}>
              返回关卡列表
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ParentGames({ store }: { store: ReturnType<typeof useAppStore> }) {
  return (
    <div className="parent-content">
      <ParentHeader title="游戏进度" />
      <p className="game-note">华容道每第一次通关一关自动记 30 积分，随账本一起到账；下面是 {store.activeChild.name} 的进度。</p>
      {store.klotski.levels.length === 0 ? (
        <EmptyState icon="🧩" title="还没有进度" text="孩子通关第一关后，这里就会出现记录。" compact />
      ) : (
        <div className="game-admin-list">
          {store.klotski.levels.map((level) => (
            <div className="game-admin-row" key={level.level}>
              <strong>
                第{level.level}关 · {level.name}
              </strong>
              <span className={level.completed ? "game-state done" : "game-state"}>
                {level.completed ? "已通关" : level.unlocked ? "可挑战" : "未解锁"}
              </span>
              <span className="game-best">{level.completed ? `最少 ${level.bestMoves} 步` : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
