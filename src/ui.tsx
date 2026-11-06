import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  holidayNameOf,
  lunarFestival,
  lunarMonthDay,
  restMark,
} from "./lunar";
import type { AppState } from "./types";

// 跨组件复用的展示层原语：不持有业务状态，也不认识 store。
// 从 App.tsx 拆出来的原因只有一个——被多个 feature 模块共用，留在 App.tsx
// 会让 feature 反过来 import App，形成循环依赖。

// favicon.svg 里同一个四角星。文字字形 ✦ 在不少系统字体里不存在，会渲染成空方块。
export function StarMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M32 9Q31.81 32.19 55 32Q31.81 31.81 32 55Q32.19 31.81 9 32Q32.19 32.19 32 9Z"
        fill="currentColor"
      />
    </svg>
  );
}

// 弹窗的统一键盘行为：Esc 关闭、打开时把焦点移进对话框、关闭后还给触发元素、
// Tab 在对话框内循环。作用域是 .modal-backdrop——所有弹窗都挂在同一层包裹里。
// 依赖数组为空：onClose 在弹窗的整个生命周期里语义稳定（调用点传的都是
// setX(null) 这样的稳定箭头函数），否则每次父组件重渲染都会把焦点抢回第一个元素。
export function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const scope = ref.current;
    if (!scope) return;
    const focusables = () =>
      Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
    // A dialog whose form field carries autoFocus has already been focused by
    // React during the commit, and it is the field the user wants: only take
    // focus when nothing inside the dialog holds it yet.
    if (!scope.contains(document.activeElement)) (focusables()[0] ?? scope).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    scope.addEventListener("keydown", onKeyDown);
    return () => {
      scope.removeEventListener("keydown", onKeyDown);
      // The trigger can be gone by now: the account menu unmounts as soon as
      // the dialog it opened appears, and focusing a detached node is a no-op
      // that leaves the user on <body>.
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return ref;
}

export function SectionTitle({
  title,
  action,
  to,
}: {
  title: string;
  action: string;
  to: string;
}) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <Link to={to}>
        {action}
        <ChevronRight size={15} />
      </Link>
    </div>
  );
}

export function Metric({
  icon,
  value,
  label,
  color,
}: {
  icon: string;
  value: string;
  label: string;
  color: string;
}) {
  return (
    <div className={`metric ${color}`}>
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

export function PageHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  compact = false,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "empty-state compact" : "empty-state"}>
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export function ConfirmModal({
  title,
  text,
  confirm,
  onClose,
  onConfirm,
}: {
  title: string;
  text: string;
  confirm: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useDialog(onClose);
  return (
    <div className="modal-backdrop" ref={dialog}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <button className="modal-close" aria-label="关闭对话框" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="modal-icon">🎁</div>
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            再想想
          </button>
          <button className="wide-primary" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ParentHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="parent-header">
      <div>
        <h1>{title}</h1>
      </div>
      {action}
    </div>
  );
}

// 日期标题上的农历小字：农历日号 + 节日/官方假期名 + 「休」「班」角标。
// 日历格子与各页标题都从这一处取，免得两套写法漂移。
export function LunarTag({ date, state }: { date: string; state: AppState }) {
  const mark = restMark(date, state.holidays, state.makeupWorkdays);
  const festival = lunarFestival(date);
  const official = holidayNameOf(date, state.holidays);
  const names = [festival, official !== festival ? official : ""].filter(Boolean);
  return (
    <span className="date-lunar">
      农历{lunarMonthDay(date)}
      {names.length > 0 && ` · ${names.join(" · ")}`}
      {mark && (
        <b className={`date-mark ${mark === "休" ? "rest" : "work"}`}>
          {mark}
        </b>
      )}
    </span>
  );
}

// 图片缩放灯箱的共享实现：双指捏合/双击/按钮缩放 + 缩放后单指拖动平移。
// shortcut: 绕图片中心缩放、不做捏合焦点跟随，平移可补偿；放大状态随图片切换重置（父级用 key）。
export function ZoomableImage({
  src,
  alt,
  onScaleChange,
}: {
  src?: string;
  alt: string;
  onScaleChange?: (scale: number) => void;
}) {
  const [scale, setScaleState] = useState(1);
  const [offset, setOffsetState] = useState({ x: 0, y: 0 });
  const [grabbing, setGrabbing] = useState(false);
  // 手势读最新的 scale/offset，避免闭包拿到旧值。
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  );
  const tap = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  // 触摸双击之后浏览器可能补一次 dblclick，别让它把缩放又切回去。
  const touchToggle = useRef(0);

  const setZoom = (next: number) => {
    const clamped = Math.min(5, Math.max(1, next));
    scaleRef.current = clamped;
    setScaleState(clamped);
    if (clamped <= 1) {
      offsetRef.current = { x: 0, y: 0 };
      setOffsetState({ x: 0, y: 0 });
    }
    onScaleChange?.(clamped);
  };
  const panTo = (x: number, y: number) => {
    offsetRef.current = { x, y };
    setOffsetState({ x, y });
  };
  const reset = () => setZoom(1);
  const zoomBy = (factor: number) => setZoom(scaleRef.current * factor);
  const toggle = () => (scaleRef.current > 1 ? reset() : setZoom(2.5));

  const onTouchStart = (event: React.TouchEvent) => {
    if ((event.target as HTMLElement).closest(".zoom-controls")) return;
    if (event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]];
      pinch.current = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        scale: scaleRef.current,
      };
      tap.current = null;
      return;
    }
    const t = event.touches[0];
    tap.current = { x: t.clientX, y: t.clientY, moved: false };
    pan.current =
      scaleRef.current > 1
        ? {
            sx: t.clientX,
            sy: t.clientY,
            ox: offsetRef.current.x,
            oy: offsetRef.current.y,
          }
        : null;
    setGrabbing(scaleRef.current > 1);
  };
  const onTouchMove = (event: React.TouchEvent) => {
    if (pinch.current && event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setZoom(pinch.current.scale * (dist / Math.max(1, pinch.current.dist)));
      return;
    }
    if (pan.current && event.touches.length === 1) {
      const t = event.touches[0];
      panTo(
        pan.current.ox + (t.clientX - pan.current.sx),
        pan.current.oy + (t.clientY - pan.current.sy),
      );
      if (tap.current) tap.current.moved = true;
      return;
    }
    if (tap.current && event.touches.length === 1) {
      const t = event.touches[0];
      if (
        Math.abs(t.clientX - tap.current.x) > 10 ||
        Math.abs(t.clientY - tap.current.y) > 10
      )
        tap.current.moved = true;
    }
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    if (pinch.current && event.touches.length < 2) {
      pinch.current = null;
      return;
    }
    if (pan.current && event.touches.length === 0) {
      const wasTap = tap.current && !tap.current.moved;
      pan.current = null;
      setGrabbing(false);
      if (!wasTap) {
        tap.current = null;
        return;
      }
      // 放大状态下没拖动 = 一次 tap，继续走双击判定。
    }
    if (tap.current && event.touches.length === 0) {
      const t = tap.current;
      tap.current = null;
      setGrabbing(false);
      if (t.moved) return;
      const now = Date.now();
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        touchToggle.current = now;
        toggle();
      } else {
        lastTap.current = now;
      }
    }
  };
  const onMouseDown = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest(".zoom-controls")) return;
    if (scaleRef.current > 1) {
      pan.current = {
        sx: event.clientX,
        sy: event.clientY,
        ox: offsetRef.current.x,
        oy: offsetRef.current.y,
      };
      setGrabbing(true);
    }
  };
  const onMouseMove = (event: React.MouseEvent) => {
    if (pan.current && grabbing)
      panTo(
        pan.current.ox + (event.clientX - pan.current.sx),
        pan.current.oy + (event.clientY - pan.current.sy),
      );
  };
  const onMouseUp = () => {
    pan.current = null;
    setGrabbing(false);
  };

  return (
    <>
      <img
        className={`zoomable-image${grabbing ? " grabbing" : ""}`}
        src={src}
        alt={alt}
        draggable={false}
        data-scale={Math.round(scale * 100) / 100}
        style={{
          transform: `translate(${offset.x}px,${offset.y}px) scale(${scale})`,
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={(event) => {
          if ((event.target as HTMLElement).closest(".zoom-controls")) return;
          zoomBy(event.deltaY < 0 ? 1.25 : 1 / 1.25);
        }}
        onDoubleClick={() => {
          if (Date.now() - touchToggle.current < 500) return;
          toggle();
        }}
      />
      <div
        className="zoom-controls"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="放大"
          onClick={() => zoomBy(1.25)}
          disabled={scale >= 5}
        >
          <ZoomIn size={18} />
        </button>
        <button
          type="button"
          aria-label="缩小"
          onClick={() => zoomBy(1 / 1.25)}
          disabled={scale <= 1}
        >
          <ZoomOut size={18} />
        </button>
        <button
          type="button"
          aria-label="重置"
          onClick={reset}
          disabled={scale === 1}
        >
          <RotateCcw size={18} />
        </button>
      </div>
    </>
  );
}
