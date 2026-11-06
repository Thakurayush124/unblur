import { score } from "../format";

/**
 * The signature element: comprehension as charted vs uncharted territory. The solid part is
 * what the team understands (the 0-100 score); the hatched remainder is not understood yet.
 */
export function CoverageBar({ comprehension, size = "lg" }: { comprehension: number; size?: "lg" | "sm" }) {
  const pct = Math.max(0, Math.min(100, comprehension));
  const h = size === "lg" ? "h-5" : "h-2.5";
  return (
    <div
      role="img"
      aria-label={`Comprehension ${score(comprehension)} out of 100; the hatched remainder is code the team does not yet understand.`}
      className={`hatch relative w-full overflow-hidden rounded-sm ${h}`}
    >
      <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function CoverageLegend() {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="inline-block h-3 w-5 rounded-sm bg-accent" /> understood
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="hatch inline-block h-3 w-5 rounded-sm" /> not yet understood
      </span>
    </div>
  );
}
