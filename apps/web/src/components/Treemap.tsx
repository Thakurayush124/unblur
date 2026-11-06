import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { HeatmapFile, HeatmapModule } from "../api";
import { useApp } from "../App";
import { inkOn, int, riskColor, RISK_LEGEND_STOPS, score } from "../format";
import { fileHref, href, navigate } from "../router";
import { squarify, type Placed } from "./squarify";

const HEIGHT = 560;
const HEADER = 20;
const GAP = 2; // surface gap between fills

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function activate(e: KeyboardEvent, to: string) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    navigate(to);
  }
}

function fileLines(f: HeatmapFile) {
  return [`risk ${score(f.risk)}`, `comprehension ${score(f.comprehension)}`, `${int(f.loc)} LOC`];
}

/**
 * Size = LOC, colour = risk. All-modules view: each module is one focusable link (Enter zooms in);
 * zoomed view: each file is focusable (Enter opens its detail page).
 */
export function Treemap({ modules, zoom }: { modules: HeatmapModule[]; zoom: string | null }) {
  const { dark } = useApp();
  const { ref, width } = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);

  const layout = useMemo(() => {
    if (!width) return [];
    const shown = zoom ? modules.filter((m) => m.module === zoom) : modules;
    return squarify(shown, (m) => m.loc, { x: 0, y: 0, w: width, h: HEIGHT }).map((m) => {
      const inner = { x: m.x + GAP, y: m.y + HEADER, w: m.w - 2 * GAP, h: m.h - HEADER - GAP };
      const files = inner.w > 4 && inner.h > 4 ? squarify(m.item.files, (f) => f.loc, inner) : [];
      return { ...m, files };
    });
  }, [modules, zoom, width]);

  const show = (e: { clientX: number; clientY: number }, title: string, lines: string[]) => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setTip({ x: e.clientX - box.left, y: e.clientY - box.top, title, lines });
  };
  const showAt = (p: Placed<unknown>, title: string, lines: string[]) =>
    setTip({ x: p.x + p.w / 2, y: p.y + Math.min(p.h, 40), title, lines });

  return (
    <div ref={ref} className="relative w-full" style={{ height: HEIGHT }} onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="group"
          aria-label={zoom ? `Files in ${zoom}` : "Modules sized by lines of code, coloured by risk"}
        >
          {layout.map((m) => {
            const label = `${m.item.module}: risk ${score(m.item.risk)}, comprehension ${score(m.item.comprehension)}, ${int(m.item.loc)} lines`;
            const moduleLink = zoom ? null : href("heatmap", { module: m.item.module });
            return (
              <g key={m.item.module}>
                <g
                  role={moduleLink ? "link" : undefined}
                  tabIndex={moduleLink ? 0 : undefined}
                  aria-label={moduleLink ? `${label}. Press Enter to zoom in.` : undefined}
                  onKeyDown={moduleLink ? (e) => activate(e, moduleLink) : undefined}
                  onFocus={() =>
                    showAt(m, m.item.module, [
                      `risk ${score(m.item.risk)}`,
                      `${int(m.item.loc)} LOC`,
                      `${m.item.files.length} files`,
                    ])
                  }
                  onBlur={() => setTip(null)}
                  onClick={moduleLink ? () => navigate(moduleLink) : undefined}
                  className={moduleLink ? "cursor-zoom-in" : undefined}
                >
                  <rect
                    x={m.x + 0.5}
                    y={m.y + 0.5}
                    width={Math.max(0, m.w - 1)}
                    height={Math.max(0, m.h - 1)}
                    fill="var(--surface-2)"
                    stroke="var(--surface-1)"
                    strokeWidth={GAP}
                  />
                  {m.w > 50 && (
                    <text x={m.x + 6} y={m.y + 14} fontSize={12} fontWeight={600} fill="var(--ink)">
                      {m.item.module.length * 7 > m.w - 50
                        ? `${m.item.module.slice(0, Math.max(3, Math.floor((m.w - 50) / 7)))}…`
                        : m.item.module}
                      <tspan fill="var(--ink-2)" fontWeight={400}>
                        {" "}
                        {score(m.item.risk)}
                      </tspan>
                    </text>
                  )}
                </g>
                {m.files.map((f) => {
                  const fill = riskColor(f.item.risk, dark);
                  const name = f.item.path.split("/").pop() ?? f.item.path;
                  const to = fileHref(f.item.path);
                  return (
                    <g
                      key={f.item.path}
                      role={zoom ? "link" : undefined}
                      tabIndex={zoom ? 0 : undefined}
                      aria-label={zoom ? `${f.item.path}: ${fileLines(f.item).join(", ")}` : undefined}
                      onKeyDown={zoom ? (e) => activate(e, to) : undefined}
                      onFocus={zoom ? () => showAt(f, f.item.path, fileLines(f.item)) : undefined}
                      onBlur={zoom ? () => setTip(null) : undefined}
                      onMouseMove={(e) => show(e, f.item.path, fileLines(f.item))}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(to);
                      }}
                      className="cursor-pointer"
                    >
                      <rect
                        x={f.x}
                        y={f.y}
                        width={Math.max(0, f.w - GAP)}
                        height={Math.max(0, f.h - GAP)}
                        rx={2}
                        fill={fill}
                      />
                      {f.w > 64 && f.h > 30 && (
                        <text
                          x={f.x + 5}
                          y={f.y + 15}
                          fontSize={11}
                          fill={inkOn(f.item.risk, dark)}
                          pointerEvents="none"
                        >
                          {name.length * 6.2 > f.w - 10
                            ? `${name.slice(0, Math.max(2, Math.floor((f.w - 10) / 6.2) - 1))}…`
                            : name}
                          <tspan x={f.x + 5} dy={13}>
                            {score(f.item.risk)}
                          </tspan>
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-sm rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(tip.x + 12, Math.max(0, width - 260)), top: tip.y + 12 }}
        >
          <div className="mb-1 break-all font-mono font-semibold text-ink">{tip.title}</div>
          {tip.lines.map((l) => (
            <div key={l} className="tabular text-ink-2">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RiskLegend() {
  const { dark } = useApp();
  const gradient = `linear-gradient(to right, ${RISK_LEGEND_STOPS.map((s) => `${riskColor(s, dark)} ${s}%`).join(", ")})`;
  return (
    <figure
      className="flex items-center gap-3 text-xs text-ink-2"
      aria-label="Colour scale: risk from 0 (low) to 100 (high)"
    >
      <span>Risk</span>
      <div>
        <div className="h-3 w-48 rounded-sm border border-line" style={{ background: gradient }} />
        <div className="flex w-48 justify-between tabular text-muted">
          {RISK_LEGEND_STOPS.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      </div>
      <span className="text-muted">size = lines of code</span>
    </figure>
  );
}
