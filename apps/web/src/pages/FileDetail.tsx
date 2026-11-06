import { enc, useApi, type FileDetail } from "../api";
import { useApp } from "../App";
import { Breakdown } from "../components/Breakdown";
import { RiskChip } from "../components/FileTable";
import { ActiveBadge, Card, Load, Notice, PageHeader, StatTile, td, th } from "../components/ui";
import { ago, date, int, pct, score } from "../format";
import { href } from "../router";

export default function FileDetailPage({ path }: { path: string }) {
  const { repoId } = useApp();
  const state = useApi<FileDetail>(path ? `/repos/${repoId}/file?path=${enc(path)}` : null);
  if (!path) return <Notice tone="error">No file selected.</Notice>;
  return (
    <Load state={state}>
      {(f) => (
        <>
          <PageHeader
            title={f.path}
            sub={
              <>
                Module{" "}
                <a className="text-accent hover:underline" href={href("heatmap", { module: f.module })}>
                  {f.module}
                </a>{" "}
                · {int(f.loc)} LOC · computed {date(f.computedAt)}
              </>
            }
          />
          <p className="mb-6 max-w-3xl rounded-lg border border-line bg-surface p-4">{f.explanation}</p>
          <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile
              label="Risk"
              value={<RiskChip risk={f.risk ?? 0} />}
              hint="criticality × (100 − comprehension)"
            />
            <StatTile label="Comprehension" value={score(f.comprehension)} />
            <StatTile
              label="Criticality"
              value={(f.criticality ?? 0).toFixed(2)}
              hint={f.criticalityReasons[0]}
            />
            <StatTile
              label="AI-written lines"
              value={pct(f.aiLineShare)}
              hint={`${int(f.aiLines)} of ${int(f.loc)} lines (git blame)`}
            />
          </dl>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Score breakdown" id="bd-h">
              {f.signals ? (
                <Breakdown s={f.signals} w={f.weights} comprehension={f.comprehension ?? 0} />
              ) : (
                <p className="text-muted">No signals yet.</p>
              )}
              {f.signals && !f.signals.reviewDataAvailable && (
                <div className="mt-3">
                  <Notice tone="warn">Review data unavailable: R is a neutral 0.5.</Notice>
                </div>
              )}
              {f.signals?.reviewDataAvailable && f.signals.reviewNote && (
                <p className="mt-3 text-sm text-ink-2">Review: {f.signals.reviewNote}.</p>
              )}
            </Card>
            <Card title="Why this criticality" id="crit-h">
              {f.criticalityReasons.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {f.criticalityReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">
                  Baseline criticality (no critical-path match, import fan-in or churn).
                </p>
              )}
            </Card>
            <Card title="Owners (current lines, by git blame)" id="own-h">
              <table className="w-full text-sm">
                <caption className="sr-only">Owners of current lines</caption>
                <thead>
                  <tr>
                    <th className={th}>Contributor</th>
                    <th className={th}>Share</th>
                    <th className={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {f.owners.map((o) => (
                    <tr key={o.id} className="border-t border-line">
                      <td className={td}>{o.name}</td>
                      <td className={`${td} tabular`}>{pct(o.share)}</td>
                      <td className={td}>
                        <ActiveBadge active={o.active} />{" "}
                        <span className="ml-1 text-xs text-muted">last commit {ago(o.lastActiveAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Humans who touched it since the AI code landed" id="touch-h">
              {f.touchers.length === 0 ? (
                <p className="text-sm text-muted">
                  Nobody. No human has made a non-AI commit to this file since its AI-written lines landed.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <caption className="sr-only">Human touchers</caption>
                  <thead>
                    <tr>
                      <th className={th}>Contributor</th>
                      <th className={th}>Last touch</th>
                      <th className={th}>Weight</th>
                      <th className={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.touchers.map((t) => (
                      <tr key={t.id} className="border-t border-line">
                        <td className={td}>{t.name}</td>
                        <td className={td}>{date(t.lastTouchAt)}</td>
                        <td className={`${td} tabular`}>{t.weight.toFixed(2)}</td>
                        <td className={td}>
                          <ActiveBadge active={t.active} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
          <div className="mt-6">
            <Card title="AI evidence (commits that still own lines)" id="ev-h">
              {f.aiSources.length === 0 ? (
                <p className="text-sm text-muted">No AI-assisted lines detected.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {f.aiSources.map((s) => (
                    <li key={s.sha} className="py-3 text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <code className="font-mono text-xs text-muted">{s.sha.slice(0, 10)}</code>
                        <span className="font-medium">{s.summary}</span>
                        <span className="text-muted">
                          {s.author} · {date(s.authoredAt)}
                          {s.prNumber ? ` · PR #${s.prNumber}` : ""}
                        </span>
                        <span className="ml-auto tabular text-ink-2">{int(s.lines)} lines</span>
                      </div>
                      <ul className="mt-1 space-y-0.5 pl-4 text-xs text-ink-2">
                        {s.evidence.map((e) => (
                          <li key={e} className="font-mono">
                            {e}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </Load>
  );
}
