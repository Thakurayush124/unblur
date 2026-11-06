import { useApi, type Knowledge, type Person } from "../api";
import { useApp } from "../App";
import { RiskChip } from "../components/FileTable";
import { Card, Load, Notice, PageHeader, td, th } from "../components/ui";
import { ago, int, pct } from "../format";
import { href } from "../router";

function Names({ people, empty }: { people: Person[]; empty: string }) {
  if (!people.length) return <span className="text-muted">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {people.map((p) => (
        <li
          key={p.id}
          className="rounded-full bg-surface-2 px-2 py-0.5 text-xs"
          title={`last commit ${ago(p.lastActiveAt)}`}
        >
          {p.name}
        </li>
      ))}
    </ul>
  );
}

/** Team view: knowledge coverage per module. Deliberately no per-person scores or rankings. */
export default function PeoplePage() {
  const { repoId, version } = useApp();
  const state = useApi<Knowledge>(`/repos/${repoId}/people`, version);
  return (
    <Load state={state}>
      {(k) => (
        <>
          <PageHeader
            title="Knowledge coverage"
            sub="Who on the team still holds working knowledge of each module. This is a team view, not a ranking of individuals."
          />
          {k.busFactorZero.length > 0 ? (
            <div className="mb-6">
              <Notice tone="warn">
                <strong>
                  {k.busFactorZero.length} module{k.busFactorZero.length > 1 ? "s have" : " has"} bus factor 0
                </strong>
                : no active contributor owns or has recently worked on{" "}
                {k.busFactorZero.length > 1 ? "them" : "it"}:{" "}
                {k.busFactorZero.map((m, i) => (
                  <span key={m}>
                    {i > 0 && ", "}
                    <a
                      className="font-mono text-accent hover:underline"
                      href={href("heatmap", { module: m })}
                    >
                      {m}
                    </a>
                  </span>
                ))}
              </Notice>
            </div>
          ) : (
            <div className="mb-6">
              <Notice>Every module has at least one active knowledge holder.</Notice>
            </div>
          )}
          <Card tour="coverage">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Knowledge holders per module, lowest bus factor first</caption>
                <thead>
                  <tr>
                    <th className={th} scope="col">
                      Module
                    </th>
                    <th className={th} scope="col">
                      Bus factor
                    </th>
                    <th className={th} scope="col">
                      Active knowledge holders
                    </th>
                    <th className={th} scope="col">
                      Departed holders
                    </th>
                    <th className={th} scope="col">
                      Risk
                    </th>
                    <th className={th} scope="col">
                      AI share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {k.modules.map((m) => (
                    <tr key={m.module} className="border-t border-line">
                      <td className={td}>
                        <a
                          className="font-mono text-[13px] text-accent hover:underline"
                          href={href("heatmap", { module: m.module })}
                        >
                          {m.module}
                        </a>
                        <div className="text-xs text-muted">
                          {m.files} {m.files === 1 ? "file" : "files"}, {int(m.loc)} lines
                        </div>
                      </td>
                      <td className={`${td} tabular`}>
                        {m.busFactor === 0 ? (
                          <span className="font-semibold text-critical">
                            <span aria-hidden>⚠ </span>0
                          </span>
                        ) : (
                          m.busFactor
                        )}
                      </td>
                      <td className={td}>
                        <Names people={m.activeHolders} empty="none" />
                      </td>
                      <td className={td}>
                        <Names people={m.departedHolders} empty="–" />
                      </td>
                      <td className={td}>
                        <RiskChip risk={m.risk} />
                      </td>
                      <td className={`${td} tabular`}>{pct(m.aiLineShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-muted">
              A knowledge holder owns at least 10% of a file's current lines, or made a non-AI commit to it
              after its AI code landed.
            </p>
          </Card>
        </>
      )}
    </Load>
  );
}
