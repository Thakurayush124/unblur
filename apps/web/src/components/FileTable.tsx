import type { FileRow } from "../api";
import { int, pct, riskColor, score } from "../format";
import { fileHref } from "../router";
import { useApp } from "../App";
import { td, th } from "./ui";

export function RiskChip({ risk }: { risk: number }) {
  const { dark } = useApp();
  return (
    <span className="inline-flex items-center gap-2 tabular">
      <span
        aria-hidden
        className="inline-block h-3 w-3 rounded-sm border border-line"
        style={{ background: riskColor(risk, dark) }}
      />
      {score(risk)}
    </span>
  );
}

export function FileTable({
  rows,
  caption,
  showExplanation = true,
}: {
  rows: FileRow[];
  caption: string;
  showExplanation?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th className={th} scope="col">
              File
            </th>
            <th className={th} scope="col">
              Risk
            </th>
            <th className={th} scope="col">
              Comprehension
            </th>
            <th className={th} scope="col">
              Criticality
            </th>
            <th className={th} scope="col">
              AI share
            </th>
            <th className={th} scope="col">
              LOC
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.path} className="border-t border-line">
              <td className={td}>
                <a href={fileHref(f.path)} className="font-mono text-[13px] text-accent hover:underline">
                  {f.path}
                </a>
                {showExplanation && <p className="mt-1 max-w-2xl text-ink-2">{f.explanation}</p>}
              </td>
              <td className={td}>
                <RiskChip risk={f.risk} />
              </td>
              <td className={`${td} tabular`}>{score(f.comprehension)}</td>
              <td className={`${td} tabular`}>{f.criticality.toFixed(2)}</td>
              <td className={`${td} tabular`}>{pct(f.aiLineShare)}</td>
              <td className={`${td} tabular`}>{int(f.loc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
