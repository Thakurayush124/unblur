import { useState, type FormEvent } from "react";

import { api, useApi, useJob, type Capabilities, type Job } from "../api";
import { useApp } from "../App";
import { JobStatus } from "../components/JobStatus";
import { Card, Load, Notice, PageHeader } from "../components/ui";
import { ago } from "../format";
import { href, navigate } from "../router";

const EXAMPLES = ["https://github.com/pallets/click", "https://github.com/sindresorhus/ky"];

export default function AddRepoPage() {
  const caps = useApi<Capabilities>("/capabilities");
  return (
    <>
      <PageHeader
        title="Add a repository"
        sub="Paste a git URL (public, or private if your git credentials can reach it) or a local checkout path. Grasp clones it, reads its history and git blame, and scores it. Source code stays on this machine."
      />
      <Load state={caps}>
        {(c) => (c.addRepos ? <AddForm caps={c} /> : <Notice tone="warn">{c.reason}</Notice>)}
      </Load>
    </>
  );
}

function AddForm({ caps }: { caps: Capabilities }) {
  const { selectRepo, reloadRepos } = useApp();
  const [source, setSource] = useState("");
  const [full, setFull] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const recent = useApi<Job[]>("/jobs", jobId ? 1 : 0);

  const job = useJob(jobId, (j) => {
    if (j.status !== "succeeded") return;
    reloadRepos();
    if (j.repoId) {
      selectRepo(j.repoId);
      navigate(href("overview"));
    }
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const j = await api<Job>("/repos", {
        method: "POST",
        body: JSON.stringify({ source: source.trim(), full }),
      });
      setJobId(j.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the analysis");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || job?.status === "queued" || job?.status === "running";
  return (
    <div className="grid gap-6">
      <Card>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Repository</span>
            <input
              type="text"
              required
              autoFocus
              spellCheck={false}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={
                caps.localPaths
                  ? "https://github.com/owner/repo  or  C:\\code\\my-repo"
                  : "https://github.com/owner/repo"
              }
              aria-describedby="source-help"
              aria-invalid={Boolean(error)}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm"
            />
            <span id="source-help" className="mt-1 block text-xs text-muted">
              https://, ssh://, git:// and git@host:owner/repo URLs are supported
              {caps.localPaths ? ", as well as local folders that contain a .git directory" : ""}.
            </span>
          </label>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="text-muted">Try:</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setSource(ex)}
                className="rounded-full bg-surface-2 px-2 py-0.5 font-mono hover:underline"
              >
                {ex.replace("https://github.com/", "")}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={full}
              onChange={(e) => setFull(e.target.checked)}
              className="h-4 w-4"
            />
            Full re-analysis (ignore cached blame from previous runs)
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || !source.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Analysing…" : "Analyse repository"}
            </button>
            <span className="text-xs text-muted">
              Large repositories can take a few minutes to clone and blame.
            </span>
          </div>
          <div aria-live="polite">
            {error && <Notice tone="error">{error}</Notice>}
            {job && <JobStatus job={job} />}
          </div>
        </form>
      </Card>
      <Load state={recent}>
        {(jobs) =>
          jobs.length > 0 ? (
            <Card title="Recent analyses" id="recent-h">
              <ul className="divide-y divide-line text-sm">
                {jobs.slice(0, 10).map((j) => (
                  <li key={j.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                    <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{j.source}</span>
                    <span className={j.status === "failed" ? "text-critical" : "text-muted"}>
                      {j.status === "failed" ? `failed: ${j.error ?? ""}` : j.status}
                    </span>
                    <span className="ml-auto text-xs text-muted">{ago(j.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null
        }
      </Load>
    </div>
  );
}
