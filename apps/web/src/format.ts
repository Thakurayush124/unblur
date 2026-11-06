export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const score = (x: number | null | undefined) => (x == null ? "–" : x.toFixed(1));
export const int = (x: number) => x.toLocaleString("en-US");

export function date(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 45) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 18 ? `${months} mo ago` : `${(days / 365).toFixed(1)} yr ago`;
}

/**
 * Risk colour, 0..100. The spec asks for green -> red; because green/red is the classic
 * colour-vision-deficiency pair, lightness carries the signal too: low risk is pale, high risk
 * is the most saturated, with a neutral gray midpoint. Cells also carry text labels.
 */
const LIGHT: [number, string][] = [
  [0, "#cfe8cc"],
  [30, "#e6eadf"],
  [50, "#f0efec"],
  [70, "#f2b8a7"],
  [85, "#e06a55"],
  [100, "#b3261e"],
];
const DARK: [number, string][] = [
  [0, "#24452a"],
  [30, "#2f3a30"],
  [50, "#383835"],
  [70, "#7a3a2e"],
  [85, "#c2483a"],
  [100, "#ef6b5f"],
];

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function riskColor(risk: number, dark: boolean): string {
  const stops = dark ? DARK : LIGHT;
  const r = Math.max(0, Math.min(100, risk));
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i]!;
    const [x0, c0] = stops[i - 1]!;
    if (r <= x1) {
      const t = (r - x0) / (x1 - x0);
      const a = hex(c0);
      const b = hex(c1);
      const mix = a.map((v, j) => Math.round(v + (b[j]! - v) * t));
      return `rgb(${mix.join(",")})`;
    }
  }
  return stops.at(-1)![1];
}

/** Ink that stays legible on a riskColor() fill. */
export function inkOn(risk: number, dark: boolean): string {
  if (dark) return risk >= 85 ? "#0b0b0b" : "#f0efec";
  return risk >= 80 ? "#ffffff" : "#0b0b0b";
}

export const RISK_LEGEND_STOPS = [0, 25, 50, 75, 100];
