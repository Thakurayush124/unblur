import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { api, type Overview } from "../api";
import { Mascot } from "../components/Mascot";
import { href, navigate, parse } from "../router";
import { TOUR_STEPS, type TourStep } from "./steps";

export const TOUR_SEEN_KEY = "grasp-tour-seen";

interface TourCtx {
  active: boolean;
  start: () => void;
}
const Ctx = createContext<TourCtx>({ active: false, start: () => {} });
export const useTour = () => useContext(Ctx);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function routeFor(step: TourStep, filePath: string | null): string {
  if (step.page === "file" && filePath) return href("file", { path: filePath });
  return href(step.page);
}

function onRoute(step: TourStep, filePath: string | null): boolean {
  const r = parse(window.location.hash);
  if (r.page !== step.page) return false;
  if (step.page === "file") return r.params.get("path") === filePath;
  if (step.page === "heatmap") return !r.params.get("module");
  return true;
}

/** Resolve once `[data-tour=name]` exists (pages load their data asynchronously). */
function waitFor(name: string, timeoutMs = 5000): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
      if (el) return resolve(el);
      if (performance.now() - t0 > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function TourProvider({
  repoId,
  autoStart,
  children,
}: {
  repoId: string;
  autoStart: boolean;
  children: ReactNode;
}) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [filePath, setFilePath] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const start = useCallback(async () => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    localStorage.setItem(TOUR_SEEN_KEY, "1");
    let path: string | null = null;
    try {
      // Show a risky file whose breakdown has something in it (not an all-hatched bar).
      const top = repoId ? (await api<Overview>(`/repos/${repoId}/overview`)).topRisk : [];
      path = (top.find((f) => f.comprehension > 0) ?? top[0])?.path ?? null;
    } catch {
      path = null;
    }
    setFilePath(path);
    setSteps(TOUR_STEPS.filter((s) => !s.needsFile || path));
    setIndex(0);
  }, [repoId]);

  const end = useCallback(() => {
    setSteps(null);
    requestAnimationFrame(() => returnFocus.current?.focus?.());
  }, []);

  // First visit: start on its own, once, when the app opens on the overview.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current || !repoId) return;
    if (localStorage.getItem(TOUR_SEEN_KEY)) return;
    if (parse(window.location.hash).page !== "overview") return;
    autoStarted.current = true;
    void start();
  }, [autoStart, repoId, start]);

  const step = steps?.[index] ?? null;
  return (
    <Ctx.Provider value={{ active: Boolean(steps), start: () => void start() }}>
      {children}
      {steps && step && (
        <TourOverlay
          key={step.id}
          step={step}
          index={index}
          total={steps.length}
          filePath={filePath}
          onBack={() => setIndex((i) => Math.max(0, i - 1))}
          onNext={() => (index + 1 < steps.length ? setIndex(index + 1) : end())}
          onClose={end}
        />
      )}
    </Ctx.Provider>
  );
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function TourOverlay({
  step,
  index,
  total,
  filePath,
  onBack,
  onNext,
  onClose,
}: {
  step: TourStep;
  index: number;
  total: number;
  filePath: string | null;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);
  const last = index === total - 1;

  // Go to the step's page, find its section, bring it into view.
  useEffect(() => {
    let live = true;
    if (!onRoute(step, filePath)) navigate(routeFor(step, filePath));
    void waitFor(step.target).then((el) => {
      if (!live) return;
      target.current = el;
      if (el) {
        const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
        el.scrollIntoView({
          block: tall ? "start" : "center",
          behavior: reducedMotion() ? "auto" : "smooth",
        });
      }
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [step, filePath]);

  // Keep the spotlight on the section while scrolling / resizing.
  useLayoutEffect(() => {
    if (!ready) return;
    let raf = 0;
    const measure = () => {
      const el = target.current;
      if (!el || !el.isConnected) return setBox(null);
      const r = el.getBoundingClientRect();
      const pad = 8;
      const top = Math.max(8, r.top - pad);
      const bottom = Math.min(window.innerHeight - 8, r.bottom + pad);
      setBox({ top, left: r.left - pad, width: r.width + pad * 2, height: Math.max(0, bottom - top) });
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    if (target.current) ro.observe(target.current);
    const settle = window.setTimeout(measure, 450); // after smooth scrolling
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
    };
  }, [ready]);

  useEffect(() => {
    if (ready) nextBtn.current?.focus({ preventScroll: true });
  }, [ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (!typing && e.key === "ArrowRight") onNext();
      else if (!typing && e.key === "ArrowLeft" && index > 0) onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onNext, onBack, onClose, index]);

  // Place the speech panel next to the section, or dock it when there's no room.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const W = Math.min(380, vw - 32);
  let pos: CSSProperties = { right: 24, bottom: 24, width: W };
  if (box && vw >= 720) {
    const below = vh - (box.top + box.height);
    const left = Math.min(Math.max(16, box.left), vw - W - 16);
    if (below > 250) pos = { top: box.top + box.height + 14, left, width: W };
    else if (box.top > 250) pos = { bottom: vh - box.top + 14, left, width: W };
  } else if (vw < 720) {
    pos = { left: 16, right: 16, bottom: 16 };
  }

  const titleId = `tour-title-${step.id}`;
  return (
    <div className="fixed inset-0 z-50" style={{ pointerEvents: "none" }}>
      {box ? (
        <div
          aria-hidden
          className="tour-spotlight fixed rounded-lg"
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
            boxShadow: "0 0 0 2px var(--accent), 0 0 0 9999px rgba(14, 22, 32, 0.5)",
          }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0" style={{ background: "rgba(14, 22, 32, 0.5)" }} />
      )}
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-body`}
        className="tour-in fixed rounded-lg border border-line bg-surface p-5 shadow-[0_12px_40px_rgba(14,22,32,0.28)]"
        style={{ ...pos, pointerEvents: "auto" }}
      >
        <div className="flex gap-4">
          <Mascot size={64} mood={step.mood} />
          <div className="min-w-0">
            <h2 id={titleId} className="t-h2">
              {step.title}
            </h2>
            <p id={`${titleId}-body`} className="mt-1.5 text-[15px] leading-relaxed text-ink-2">
              {step.body}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="tabular text-sm text-muted" aria-live="polite">
            Step {index + 1} of {total}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {!last && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-2.5 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
              >
                Skip tour
              </button>
            )}
            {index > 0 && (
              <button
                type="button"
                onClick={onBack}
                className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface-2"
              >
                Back
              </button>
            )}
            <button
              ref={nextBtn}
              type="button"
              onClick={onNext}
              className="rounded-md bg-accent px-3.5 py-1.5 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              {last ? "Finish tour" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Floating Hatch in the corner: restarts the tour. Hidden while the tour runs. */
export function TourLauncher() {
  const { active, start } = useTour();
  // Stays mounted (just hidden) during the tour so focus can return to it afterwards.
  return (
    <button
      type="button"
      hidden={active}
      onClick={start}
      aria-label="Take the guided tour with Hatch"
      title="Take the guided tour"
      className="group fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-1.5 pr-4 shadow-[0_6px_24px_rgba(14,22,32,0.18)] hover:border-accent"
    >
      <Mascot size={40} mood="wave" />
      <span className="text-sm font-semibold">Guide</span>
    </button>
  );
}
