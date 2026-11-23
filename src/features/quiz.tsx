import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { useAppStore } from "../store";
import { PageHeading } from "../ui";
import {
  PATTERN_QUESTIONS,
  makeCalcProblem,
  makePatternRound,
  rngFrom,
} from "./quizzes";
import type { CalcProblem, PatternItem } from "./quizzes";

// 二年级的两个题类游戏：口算闯关（60 秒速算，答对一题 1 分）与找规律（10 题
// 序列填空，百分制）。题目由 src/features/quizzes.ts 的纯生成器按种子现发，
// 服务端只收成绩——信任级别同华容道上报的步数。?seed= 只为验证门固定出题。

// 一局结束后的结算：上报回来的 awarded 决定「获得 +N」胶囊，失败可原样重试。
interface Settlement {
  score: number;
  awarded: number;
  failed: boolean;
}

function newSeed(params: URLSearchParams): number {
  const seed = Number(params.get("seed"));
  if (Number.isInteger(seed) && seed > 0) return seed;
  return ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
}

function newRng(params: URLSearchParams): () => number {
  return rngFrom(newSeed(params));
}

// 断点存档：服务端原样回带的不透明 JSON，形状在这一端校验，不合就当没有存档。
// 口算存「档位 + 已答对 + 剩余秒数」，回来接着倒计时；找规律存种子（同种子生成
// 同一局题）+ 题号 + 失误数。
const calcSave = "timed_calc";
const patternSave = "pattern_quiz";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

type CalcSave = { tier: number; score: number; seconds: number };

function readCalcSave(state: unknown): CalcSave | null {
  if (!state || typeof state !== "object") return null;
  const { tier, score, seconds } = state as Record<string, unknown>;
  if (!isCount(tier) || tier < 1 || tier > 3) return null;
  if (!isCount(score) || !isCount(seconds) || seconds > 60) return null;
  return { tier, score, seconds };
}

type PatternSave = { seed: number; index: number; mistakes: number };

function readPatternSave(state: unknown): PatternSave | null {
  if (!state || typeof state !== "object") return null;
  const { seed, index, mistakes } = state as Record<string, unknown>;
  if (!isCount(seed) || seed <= 0) return null;
  if (!isCount(index) || index >= PATTERN_QUESTIONS) return null;
  if (!isCount(mistakes) || mistakes > 20) return null;
  return { seed, index, mistakes };
}

// 答题反馈共用：点一下选项，闪 400ms 正确/错误再进下一题。
interface Flash {
  value: string | number;
  ok: boolean;
}

const FLASH_MS = 400;

export function CalcSprint({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [params] = useSearchParams();
  // 挂载时读一次断点；剩下的秒数已经是 0 的存档当作无效（那一局其实已经结束了）。
  const [resume] = useState(() => {
    const saved = readCalcSave(store.gameSaves[calcSave]);
    return saved && saved.seconds > 0 ? saved : null;
  });
  const [phase, setPhase] = useState<"intro" | "play" | "done">("intro");
  const [tier, setTier] = useState(1);
  const [problem, setProblem] = useState<CalcProblem | null>(null);
  const [score, setScore] = useState(0);
  const [seconds, setSeconds] = useState(60);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [result, setResult] = useState<Settlement | null>(null);
  const rngRef = useRef<() => number>(rngFrom(1));
  const scoreRef = useRef(0);
  const tierRef = useRef(1);
  const endedRef = useRef(false);
  // 交卷之后不再写断点：否则结算完又冒出一个「继续上次」的局。
  const savesOff = useRef(false);
  const [busy, setBusy] = useState(false);

  const view = store.quizzes.games.find((game) => game.game === "timed_calc");

  // carry 是断点带上来的得分与剩余秒数；三个档位按钮走的就是全新的 60 秒。
  const start = (
    nextTier: number,
    carry?: { score: number; seconds: number },
  ) => {
    rngRef.current = newRng(params);
    tierRef.current = nextTier;
    scoreRef.current = carry?.score ?? 0;
    endedRef.current = false;
    savesOff.current = false;
    setTier(nextTier);
    setScore(scoreRef.current);
    setSeconds(carry?.seconds ?? 60);
    setFlash(null);
    setResult(null);
    setProblem(makeCalcProblem(rngRef.current, nextTier));
    setPhase("play");
  };

  // 秒数、得分、档位任一变化就覆盖断点（每秒一次，单机单用户，不值得加节流）。
  useEffect(() => {
    if (phase !== "play" || savesOff.current) return;
    store.actions.saveGame(calcSave, { tier, score, seconds });
  }, [phase, tier, score, seconds]);

  const finish = async () => {
    // 不查 phase 也不查 endedRef：交卷按钮、倒计时归零、结算页的失败重试都走
    // 这里；防重复提交由 busy 负责（endedRef 只用来掐掉还在飞的答题回调）。
    if (busy) return;
    endedRef.current = true;
    savesOff.current = true;
    store.actions.clearGame(calcSave);
    setBusy(true);
    const finalScore = scoreRef.current;
    const awarded = await store.actions.submitQuizScore({
      game: "timed_calc",
      score: finalScore,
      level: tierRef.current,
      seconds: 60,
    });
    setResult({ score: finalScore, awarded: awarded ?? 0, failed: awarded === undefined });
    setPhase("done");
    setBusy(false);
  };

  // 60 秒倒计时：读秒归零自动交卷。
  useEffect(() => {
    if (phase !== "play") return;
    if (seconds <= 0) {
      void finish();
      return;
    }
    const timer = window.setTimeout(() => setSeconds((prev) => prev - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, seconds]);

  const answer = (choice: number) => {
    if (flash || endedRef.current || phase !== "play" || !problem) return;
    const ok = choice === problem.answer;
    setFlash({ value: choice, ok });
    window.setTimeout(() => {
      if (endedRef.current) return;
      setFlash(null);
      if (ok) {
        scoreRef.current += 1;
        setScore(scoreRef.current);
      }
      setProblem(makeCalcProblem(rngRef.current, tierRef.current));
    }, FLASH_MS);
  };

  const back = (
    <p className="klotski-back">
      <Link to="/child/games">
        <ChevronLeft size={14} /> 返回关卡列表
      </Link>
    </p>
  );

  if (phase === "intro")
    return (
      <div className="content-wrap quiz-screen">
        <PageHeading title="口算闯关" description="60 秒内答对越多越好，答对一题记 1 分，每局都计入积分。" />
        {resume ? (
          <button
            className="wide-primary"
            onClick={() => start(resume.tier, { score: resume.score, seconds: resume.seconds })}
          >
            继续上次（第 {resume.tier} 档 · 已答对 {resume.score} 题 · 剩 {resume.seconds} 秒）
          </button>
        ) : null}
        <p className="quiz-level-prompt">选题档重新开一局：</p>
        <div className="quiz-levels">
          {["第1档 · 20 以内加减", "第2档 · 100 以内加减", "第3档 · 表内乘除"].map((label, index) => (
            <button key={label} className="outline-button" onClick={() => start(index + 1)}>
              {label}
            </button>
          ))}
        </div>
        {view ? (
          <p className="quiz-best">今天最好 {view.todayBest} 题 · 历史最好 {view.allTimeBest} 题</p>
        ) : null}
        {back}
      </div>
    );

  if (phase === "play")
    return (
      <div className="content-wrap quiz-screen">
        <div className="quiz-meta">
          <span className="quiz-timer" aria-label="剩余秒数">
            ⏱ {seconds} 秒
          </span>
          <span>答对 {score} 题</span>
          <button className="outline-button" onClick={() => void finish()} disabled={busy}>
            交卷
          </button>
        </div>
        {problem ? (
          <>
            <p className="quiz-problem">
              {problem.left} {problem.op} {problem.right} = ?
            </p>
            <div className="quiz-choices">
              {problem.choices.map((choice) => (
                <button
                  key={choice}
                  className={`quiz-choice${flash?.value === choice ? (flash.ok ? " correct" : " wrong") : ""}`}
                  onClick={() => answer(choice)}
                  disabled={busy}
                >
                  {choice}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    );

  return (
    <div className="content-wrap quiz-screen">
      <PageHeading title="口算闯关" description="本局结算" />
      <p className="quiz-result" role="status">
        答对 <strong>{result?.score ?? 0}</strong> 题
      </p>
      {result?.failed ? (
        <button
          className="klotski-retry"
          onClick={() => {
            endedRef.current = false;
            void finish();
          }}
        >
          成绩上报失败，点击重试
        </button>
      ) : result && result.awarded > 0 ? (
        <p className="quiz-record">
          本局获得 <span className="quiz-award">+{result.awarded}</span>
        </p>
      ) : (
        <p className="quiz-record">这一局还没答对题，下次加油</p>
      )}
      <div className="quiz-actions">
        <button className="secondary-button" onClick={() => start(tier)}>
          再来一局
        </button>
        <Link className="wide-primary" to="/child/games">
          返回关卡列表
        </Link>
      </div>
    </div>
  );
}

export function PatternQuiz({ store }: { store: ReturnType<typeof useAppStore> }) {
  const [params] = useSearchParams();
  // 挂载时读一次断点；用存档的种子重新造出同一局题，题号与失误数一并接上。
  const [resume] = useState(() => readPatternSave(store.gameSaves[patternSave]));
  const [phase, setPhase] = useState<"intro" | "play" | "done">("intro");
  const [seed, setSeed] = useState(0);
  const [items, setItems] = useState<PatternItem[]>([]);
  const [index, setIndex] = useState(0);
  const [mistakes, setMistakes] = useState(0);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [result, setResult] = useState<Settlement | null>(null);
  const mistakesRef = useRef(0);
  const endedRef = useRef(false);
  // 交卷之后不再写断点（理由同口算）。
  const savesOff = useRef(false);
  const [busy, setBusy] = useState(false);

  const view = store.quizzes.games.find((game) => game.game === "pattern_quiz");

  const begin = (nextSeed: number, at: number, wrong: number) => {
    setSeed(nextSeed);
    setItems(makePatternRound(rngFrom(nextSeed)));
    setIndex(at);
    setMistakes(wrong);
    mistakesRef.current = wrong;
    endedRef.current = false;
    savesOff.current = false;
    setFlash(null);
    setResult(null);
    setPhase("play");
  };

  const start = () => begin(newSeed(params), 0, 0);

  // 题号、失误数、种子任一变化就覆盖断点。
  useEffect(() => {
    if (phase !== "play" || savesOff.current) return;
    store.actions.saveGame(patternSave, { seed, index, mistakes });
  }, [phase, seed, index, mistakes]);

  const finish = async (wrong: number) => {
    if (busy) return;
    endedRef.current = true;
    savesOff.current = true;
    store.actions.clearGame(patternSave);
    setBusy(true);
    const score = (PATTERN_QUESTIONS - wrong) * 10;
    const awarded = await store.actions.submitQuizScore({
      game: "pattern_quiz",
      score,
      level: 3,
      mistakes: wrong,
    });
    setResult({ score, awarded: awarded ?? 0, failed: awarded === undefined });
    setPhase("done");
    setBusy(false);
  };

  const answer = (choice: string, item: PatternItem) => {
    if (flash || endedRef.current || phase !== "play") return;
    const ok = choice === item.answer;
    setFlash({ value: choice, ok });
    window.setTimeout(() => {
      if (endedRef.current) return;
      setFlash(null);
      let wrong = mistakesRef.current;
      if (!ok) {
        wrong += 1;
        mistakesRef.current = wrong;
        setMistakes(wrong);
      }
      if (index + 1 >= items.length) void finish(wrong);
      else setIndex(index + 1);
    }, FLASH_MS);
  };

  const back = (
    <p className="klotski-back">
      <Link to="/child/games">
        <ChevronLeft size={14} /> 返回关卡列表
      </Link>
    </p>
  );

  if (phase === "intro")
    return (
      <div className="content-wrap quiz-screen">
        <PageHeading title="找规律" description={`一局 ${PATTERN_QUESTIONS} 题：图形周期、等差数列和两步规律各一段，答对一题 10 分，答错一次记 1 次失误。`} />
        <div className="quiz-levels">
          <button className="wide-primary" onClick={start}>
            开始找规律
          </button>
          {resume ? (
            <button
              className="outline-button"
              onClick={() => begin(resume.seed, resume.index, resume.mistakes)}
            >
              继续上次（第 {resume.index + 1} / {PATTERN_QUESTIONS} 题）
            </button>
          ) : null}
        </div>
        {view ? (
          <p className="quiz-best">今天最好 {view.todayBest} 分 · 历史最好 {view.allTimeBest} 分</p>
        ) : null}
        {back}
      </div>
    );

  const item = items[index];
  if (phase === "play" && item)
    return (
      <div className="content-wrap quiz-screen">
        <div className="quiz-meta">
          <span>第 {index + 1} / {items.length} 题</span>
          <span>失误 {mistakes} 次</span>
        </div>
        <div className="pattern-seq" aria-label="找规律序列">
          {item.display.map((tile, position) => (
            <span
              key={`${index}-${position}`}
              className={`pattern-tile${tile === "?" ? " pattern-ask" : ""}`}
            >
              {tile}
            </span>
          ))}
        </div>
        <div className="quiz-choices pattern-choices">
          {item.choices.map((choice) => (
            <button
              key={choice}
              className={`quiz-choice${flash?.value === choice ? (flash.ok ? " correct" : " wrong") : ""}`}
              onClick={() => answer(choice, item)}
              disabled={busy}
            >
              {choice}
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div className="content-wrap quiz-screen">
      <PageHeading title="找规律" description="本局结算" />
      <p className="quiz-result" role="status">
        答对 <strong>{PATTERN_QUESTIONS - mistakes}</strong> 题 · 得分{" "}
        <strong>{result?.score ?? 0}</strong> 分
      </p>
      {result?.failed ? (
        <button className="klotski-retry" onClick={() => void finish(mistakesRef.current)}>
          成绩上报失败，点击重试
        </button>
      ) : result && result.awarded > 0 ? (
        <p className="quiz-record">
          本局获得 <span className="quiz-award">+{result.awarded}</span>
        </p>
      ) : (
        <p className="quiz-record">这一局还没答对题，下次加油</p>
      )}
      <div className="quiz-actions">
        <button className="secondary-button" onClick={start}>
          再来一局
        </button>
        <Link className="wide-primary" to="/child/games">
          返回关卡列表
        </Link>
      </div>
    </div>
  );
}
