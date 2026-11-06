import type { Job } from "../api";
import { Notice } from "./ui";

/** Live status of an analysis job: progress line while running, error + log tail on failure. */
export function JobStatus({ job }: { job: Job }) {
  if (job.status === "failed") {
    return (
      <Notice tone="error">
        <p className="font-medium">Analysis failed: {job.error ?? "unknown error"}</p>
        {job.log.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer">Worker output</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-2">
              {job.log.slice(-20).join("\n")}
            </pre>
          </details>
        )}
      </Notice>
    );
  }
  if (job.status === "succeeded") return <Notice>Analysis finished.</Notice>;
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
    >
      <span
        aria-hidden
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent"
      />
      <span>
        <span className="font-medium">{job.status === "queued" ? "Queued" : "Analysing"}</span>
        <span className="text-ink-2">: {job.progress}</span>
      </span>
    </div>
  );
}
