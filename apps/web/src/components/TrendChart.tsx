import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Overview } from "../api";
import { date, score } from "../format";
import { th, td } from "./ui";

const SERIES = [
  { key: "comprehension", label: "Comprehension", color: "var(--series-1)" },
  { key: "risk", label: "Risk", color: "var(--series-2)" },
] as const;

type Point = Overview["trend"][number];

/** Comprehension and risk share one 0-100 axis, so one chart, one y-scale. */
export function TrendChart({ trend }: { trend: Point[] }) {
  const data = trend.map((p) => ({ ...p, t: new Date(p.takenAt).getTime() }));
  const last = data.at(-1);
  return (
    <div>
      {trend.length < 2 && (
        <p className="mb-2 text-sm text-muted">A trend line appears after the second analysis run.</p>
      )}
      <div
        className="h-64"
        role="img"
        aria-label={`Trend of comprehension and risk over ${trend.length} analysis runs. Latest: comprehension ${score(last?.comprehension)}, risk ${score(last?.risk)}.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 136, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t: number) => date(new Date(t).toISOString())}
              stroke="var(--axis)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              tickLine={false}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              stroke="var(--axis)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ stroke: "var(--axis)" }}
              contentStyle={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--ink)",
              }}
              labelStyle={{ color: "var(--ink-2)" }}
              labelFormatter={(t) => date(new Date(Number(t)).toISOString())}
              formatter={(v, name) => [score(Number(v)), name]}
            />
            <Legend
              wrapperStyle={{ fontSize: 13 }}
              formatter={(value) => <span style={{ color: "var(--ink-2)" }}>{value}</span>}
            />
            {SERIES.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={{ r: 4, fill: s.color, stroke: "var(--surface-1)", strokeWidth: 2 }}
                activeDot={{ r: 6, stroke: "var(--surface-1)", strokeWidth: 2 }}
                isAnimationActive={false}
                label={(props: { x?: unknown; y?: unknown; index?: number; value?: unknown }) =>
                  props.index === data.length - 1 ? (
                    <text
                      key={s.key}
                      x={Number(props.x) + 10}
                      y={Number(props.y) + 4}
                      fontSize={12}
                      fill="var(--ink-2)"
                    >
                      {s.label} {score(Number(props.value))}
                    </text>
                  ) : (
                    <g key={`${s.key}-${props.index}`} />
                  )
                }
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-ink-2">Show as table</summary>
        <table className="mt-2 w-full">
          <caption className="sr-only">Comprehension and risk per analysis run</caption>
          <thead>
            <tr>
              <th className={th}>Run</th>
              <th className={th}>Commit</th>
              <th className={th}>Comprehension</th>
              <th className={th}>Risk</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {trend.map((p) => (
              <tr key={p.takenAt} className="border-t border-line">
                <td className={td}>{date(p.takenAt)}</td>
                <td className={`${td} font-mono text-xs`}>{p.headSha.slice(0, 8)}</td>
                <td className={td}>{score(p.comprehension)}</td>
                <td className={td}>{score(p.risk)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
