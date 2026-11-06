import { useApi, type Overview } from "../api";
import { useApp } from "../App";
import { AnalyzeButton } from "../components/AnalyzeButton";
import { CoverageBar, CoverageLegend } from "../components/Coverage";
import { FileTable } from "../components/FileTable";
import { TrendChart } from "../components/TrendChart";
import { Card, Figures, Load, Notice, StatTile } from "../components/ui";
import { date, int, pct, score } from "../format";
import { href } from "../router";

export default function OverviewPage() {
  const { repoId, version } = useApp();
  const state = useApi<Overview>(`/repos/${repoId}/overview`, version);
  return (
    <Load state={state}>
      {(o) => (
        <>
          <header className="mb-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="t-h1 [overflow-wrap:anywhere]">{o.repo.name}</h1>
                <p className="mt-1 text-ink-2">
                  Analysed {date(o.repo.lastAnalyzedAt)} at{" "}
                  <code className="font-mono text-[0.9em]">{o.repo.lastAnalyzedSha?.slice(0, 8)}</code> on{" "}
                  {o.repo.defaultBranch}
                </p>
              </div>
              <AnalyzeButton />
            </div>

            <div className="mt-8 grid items-end gap-x-10 gap-y-6 md:grid-cols-[auto_1fr]">
              <div>
                <p className="text-sm text-ink-2">Comprehension</p>
                <p className="t-hero tabular mt-1">
                  {score(o.comprehension)}
                  <span className="ml-1 font-sans text-lg font-normal tracking-normal text-muted">/ 100</span>
                </p>
              </div>
              <div className="min-w-0 pb-2">
                <p className="mb-3 max-w-2xl text-ink-2">
                  How much of this codebase the people still on the team understand, weighted by size. Risk is{" "}
                  <strong className="font-semibold text-ink">{score(o.risk)}</strong>: comprehension gaps in
                  code that matters.
                </p>
                <CoverageBar comprehension={o.comprehension ?? 0} />
                <div className="mt-2">
                  <CoverageLegend />
                </div>
              </div>
            </div>
          </header>

          {!o.reviewDataAvailable && (
            <div className="mb-8">
              <Notice tone="warn">
                Review data unavailable: review depth (R) is a neutral 0.5 for every file. Connect the GitHub
                App or pass <code>--pr-data</code> to the worker.
              </Notice>
            </div>
          )}

          <div className="mb-12">
            <Figures>
              <StatTile
                label={`Files at risk ≥ ${o.riskThreshold}`}
                value={int(o.totals.filesAboveThreshold)}
                hint={`of ${int(o.totals.files)} files`}
              />
              <StatTile
                label="Modules nobody active knows"
                value={
                  <a
                    href={href("people")}
                    className="underline decoration-rule underline-offset-4 hover:decoration-accent"
                  >
                    {o.totals.busFactorZeroModules}
                  </a>
                }
                hint={`of ${o.totals.modules} modules (bus factor 0)`}
              />
              <StatTile
                label="AI-written lines"
                value={pct(o.totals.aiLineShare)}
                hint={`of ${int(o.totals.loc)} lines, by git blame`}
              />
              <StatTile
                label="Active contributors"
                value={`${o.totals.activeContributors} of ${o.totals.contributors}`}
                hint="committed in the last 90 days"
              />
            </Figures>
          </div>

          <div className="grid gap-12">
            <Card title="Trend" id="trend-h">
              <TrendChart trend={o.trend} />
            </Card>
            <Card
              title="Top 10 riskiest files"
              id="top-h"
              actions={
                <a href={href("heatmap")} className="text-sm text-accent underline-offset-4 hover:underline">
                  Open the heatmap
                </a>
              }
            >
              <FileTable rows={o.topRisk} caption="Ten riskiest files with explanations" />
            </Card>
          </div>
        </>
      )}
    </Load>
  );
}
