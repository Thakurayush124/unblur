import { useApi, type Overview } from "../api";
import { useApp } from "../App";
import { AnalyzeButton } from "../components/AnalyzeButton";
import { FileTable } from "../components/FileTable";
import { TrendChart } from "../components/TrendChart";
import { Card, Load, Notice, PageHeader, StatTile } from "../components/ui";
import { date, int, pct, score } from "../format";
import { href } from "../router";

export default function OverviewPage() {
  const { repoId, version } = useApp();
  const state = useApi<Overview>(`/repos/${repoId}/overview`, version);
  return (
    <Load state={state}>
      {(o) => (
        <>
          <PageHeader
            title={o.repo.name}
            actions={<AnalyzeButton />}
            sub={
              <>
                Analysed {date(o.repo.lastAnalyzedAt)} at{" "}
                <code className="font-mono">{o.repo.lastAnalyzedSha?.slice(0, 8)}</code> on{" "}
                {o.repo.defaultBranch}
              </>
            }
          />
          {!o.reviewDataAvailable && (
            <div className="mb-4">
              <Notice tone="warn">
                Review data unavailable: review depth (R) is a neutral 0.5 for every file. Connect the GitHub
                App or pass <code>--pr-data</code> to the worker.
              </Notice>
            </div>
          )}
          <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Comprehension" value={score(o.comprehension)} hint="0–100, LOC-weighted" />
            <StatTile label="Risk" value={score(o.risk)} hint="criticality × (100 − comprehension)" />
            <StatTile
              label={`Files at risk ≥ ${o.riskThreshold}`}
              value={int(o.totals.filesAboveThreshold)}
              hint={`of ${int(o.totals.files)} files`}
            />
            <StatTile
              label="Bus-factor-0 modules"
              value={
                <a href={href("people")} className="hover:underline">
                  {o.totals.busFactorZeroModules}
                </a>
              }
              hint={`of ${o.totals.modules} modules`}
            />
            <StatTile
              label="AI-written lines"
              value={pct(o.totals.aiLineShare)}
              hint={`${int(o.totals.loc)} LOC · ${o.totals.activeContributors}/${o.totals.contributors} contributors active`}
            />
          </dl>
          <div className="grid gap-6">
            <Card title="Trend" id="trend-h">
              <TrendChart trend={o.trend} />
            </Card>
            <Card
              title="Top 10 riskiest files"
              id="top-h"
              actions={
                <a href={href("heatmap")} className="text-sm text-accent hover:underline">
                  Open heatmap →
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
