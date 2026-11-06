import { useState } from "react";

import { api, useApi, useJob, type Capabilities, type Job } from "../api";
import { useApp } from "../App";
import { JobStatus } from "./JobStatus";

/** "Re-analyse" for the current repo: incremental by default, re-renders the page when done. */
export function AnalyzeButton() {
  const { repoId, refresh } = useApp();
  const caps = useApi<Capabilities>("/capabilities");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(jobId, (j) => {
    if (j.status === "succeeded") refresh();
  });

  if (caps.status !== "ok" || !caps.data.analyze) return null;
  const busy = job?.status === "queued" || job?.status === "running";

  async function start() {
    setError(null);
    try {
      setJobId((await api<Job>(`/repos/${repoId}/analyze`, { method: "POST", body: "{}" })).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the analysis");
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-60"
      >
        {busy ? "Analysing…" : "Re-analyse"}
      </button>
      <div aria-live="polite" className="max-w-md">
        {error && <span className="text-sm text-critical">{error}</span>}
        {job && job.status !== "succeeded" && <JobStatus job={job} />}
      </div>
    </div>
  );
}
