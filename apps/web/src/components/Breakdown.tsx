import type { FileDetail } from "../api";
import { score } from "../format";
import { td, th } from "./ui";

type Sig = NonNullable<FileDetail["signals"]>;
type W = NonNullable<FileDetail["weights"]>;

/**
 * Stacked 0-100 bar: each segment is one signal's contribution to comprehension; the remainder
 * is the comprehension the file has not earned. Categorical slots 1-4 in fixed order, 2px gaps,
 * values labelled in the legend and table (slots 3-4 are < 3:1 on light, so labels are required).
 */
export function Breakdown({ s, w, comprehension }: { s: Sig; w: W | null; comprehension: number }) {
  const rows = [
    {
      key: "a",
      label: "Human-written share (1 − A)",
      color: "var(--series-1)",
      points: s.contributions.a,
      value: 1 - s.a,
      weight: w?.wA,
    },
    {
      key: "r",
      label: "Review depth (R)",
      color: "var(--series-2)",
      points: s.contributions.r,
      value: s.r,
      weight: w?.wR,
    },
    {
      key: "hk",
      label: "Human touch × retention (H·K)",
      color: "var(--series-3)",
      points: s.contributions.hk,
      value: s.h * s.k,
      weight: w?.wH,
    },
    {
      key: "e",
      label: "Verified understanding (E)",
      color: "var(--series-4)",
      points: s.contributions.e,
      value: s.e,
      weight: w?.wE,
    },
  ];
  const earned = rows.reduce((t, r) => t + r.points, 0);
  const scale = Math.max(100, earned);
  return (
    <div>
      <div
        className="flex h-7 w-full gap-[2px] overflow-hidden rounded"
        role="img"
        aria-label={`Comprehension ${score(comprehension)} of 100: ${rows.map((r) => `${r.label} ${score(r.points)} points`).join("; ")}.`}
      >
        {rows
          .filter((r) => r.points > 0)
          .map((r) => (
            <div
              key={r.key}
              title={`${r.label}: ${score(r.points)} pts`}
              style={{ width: `${(r.points / scale) * 100}%`, background: r.color }}
            />
          ))}
        <div className="hatch flex-1" title="Not earned: comprehension this file has not yet earned" />
      </div>
      <div className="mt-1 flex justify-between text-xs tabular text-muted">
        <span>0</span>
        <span>comprehension {score(comprehension)}</span>
        <span>100</span>
      </div>
      <table className="mt-4 w-full text-sm">
        <caption className="sr-only">Signal breakdown</caption>
        <thead>
          <tr>
            <th className={th} scope="col">
              Signal
            </th>
            <th className={th} scope="col">
              Value (0–1)
            </th>
            <th className={th} scope="col">
              Weight
            </th>
            <th className={th} scope="col">
              Points
            </th>
          </tr>
        </thead>
        <tbody className="tabular">
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-line">
              <th scope="row" className={`${td} text-left font-normal`}>
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-3 w-3 rounded-sm"
                    style={{ background: r.color }}
                  />
                  {r.label}
                </span>
              </th>
              <td className={td}>{r.value.toFixed(2)}</td>
              <td className={td}>{r.weight?.toFixed(2) ?? "–"}</td>
              <td className={td}>{score(r.points)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-semibold">
            <th scope="row" className={`${td} text-left`}>
              Comprehension
            </th>
            <td className={td} />
            <td className={td} />
            <td className={td}>{score(comprehension)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
