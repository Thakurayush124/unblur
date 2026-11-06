import { useState } from "react";

import { useApi, type HeatmapModule } from "../api";
import { useApp } from "../App";
import { RiskChip } from "../components/FileTable";
import { RiskLegend, Treemap } from "../components/Treemap";
import { Card, Load, Notice, PageHeader, td, th } from "../components/ui";
import { int, score } from "../format";
import { fileHref, href } from "../router";

export default function HeatmapPage({ module }: { module: string | null }) {
  const { repoId, version } = useApp();
  const state = useApi<{ modules: HeatmapModule[] }>(`/repos/${repoId}/heatmap`, version);
  const [asTable, setAsTable] = useState(false);

  return (
    <Load state={state}>
      {({ modules }) => {
        const zoomed = module ? modules.find((m) => m.module === module) : undefined;
        if (module && !zoomed) return <Notice tone="error">Module not found: {module}</Notice>;
        return (
          <>
            <PageHeader
              title={zoomed ? zoomed.module : "Heatmap"}
              sub={
                zoomed ? (
                  <>
                    {zoomed.files.length} files and {int(zoomed.loc)} lines, module risk {score(zoomed.risk)}.{" "}
                    <a href={href("heatmap")} className="text-accent underline-offset-4 hover:underline">
                      Back to all modules
                    </a>
                  </>
                ) : (
                  "Where risky code lives. Select a module to zoom in, then a file for its breakdown."
                )
              }
            />
            <Card
              tour="treemap"
              actions={
                <div className="flex w-full flex-wrap items-center justify-between gap-3">
                  <RiskLegend />
                  <button
                    type="button"
                    onClick={() => setAsTable((v) => !v)}
                    aria-pressed={asTable}
                    className="rounded-md border border-line px-3 py-1 text-sm hover:bg-surface-2"
                  >
                    {asTable ? "Show treemap" : "Show as table"}
                  </button>
                </div>
              }
            >
              {asTable ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      {zoomed ? `Files in ${zoomed.module}` : "Modules"} by risk
                    </caption>
                    <thead>
                      <tr>
                        <th className={th}>{zoomed ? "File" : "Module"}</th>
                        <th className={th}>Risk</th>
                        <th className={th}>Comprehension</th>
                        <th className={th}>LOC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(zoomed
                        ? zoomed.files.map((f) => ({
                            key: f.path,
                            name: f.path,
                            link: fileHref(f.path),
                            ...f,
                          }))
                        : modules.map((m) => ({
                            key: m.module,
                            name: m.module,
                            link: href("heatmap", { module: m.module }),
                            ...m,
                          }))
                      ).map((r) => (
                        <tr key={r.key} className="border-t border-line">
                          <td className={td}>
                            <a href={r.link} className="font-mono text-[13px] text-accent hover:underline">
                              {r.name}
                            </a>
                          </td>
                          <td className={td}>
                            <RiskChip risk={r.risk} />
                          </td>
                          <td className={`${td} tabular`}>{score(r.comprehension)}</td>
                          <td className={`${td} tabular`}>{int(r.loc)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Treemap modules={modules} zoom={module} />
              )}
            </Card>
          </>
        );
      }}
    </Load>
  );
}
