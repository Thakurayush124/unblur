/**
 * Analysis jobs: run the Python worker CLI (`cli.py analyze <source>`) as a child process.
 * One job runs at a time; duplicates for a source that is already queued/running are merged.
 * No shell is involved: arguments are passed as an array, and sources are validated first.
 * (Phase 4 swaps the runner for a BullMQ queue; the Job shape stays the same.)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  source: string;
  full: boolean;
  status: JobStatus;
  progress: string;
  log: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  repoId: string | null;
  error: string | null;
}

export interface RunResult {
  code: number | null;
}
/** Runs `args` and streams output lines. Injectable so tests don't need Python. */
export type Runner = (
  args: string[],
  onLine: (line: string) => void,
  signal: AbortSignal,
) => Promise<RunResult>;

export interface JobOptions {
  cliPath: string;
  python: string;
  workdir: string;
  dataDir?: string;
  mongoUrl?: string;
  mongoDb?: string;
  timeoutMs?: number;
  runner?: Runner;
}

const LOG_LINES = 60;
const KEEP_JOBS = 50;
// Same rules as worker/grasp/ingest/source.py.
const REMOTE = /^(?:https?:\/\/|ssh:\/\/|git:\/\/)[\w.@:-]+\/[\w./~-]+$|^[\w.-]+@[\w.-]+:[\w./~-]+$/;

export function isRemote(source: string): boolean {
  return REMOTE.test(source);
}

export function processRunner(python: string): Runner {
  return (args, onLine, signal) =>
    new Promise((resolve) => {
      const child = spawn(python, args, {
        shell: false,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", GIT_TERMINAL_PROMPT: "0" },
      });
      const split = (buf: Buffer) => buf.toString("utf-8").split(/\r?\n/).filter(Boolean).forEach(onLine);
      child.stdout.on("data", split);
      child.stderr.on("data", split);
      const kill = () => child.kill();
      signal.addEventListener("abort", kill, { once: true });
      child.on("error", (e) => {
        onLine(`error: could not start ${python}: ${e.message}`);
        resolve({ code: null });
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", kill);
        resolve({ code });
      });
    });
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private queue: { job: Job; out: string | null }[] = [];
  private running = false;
  private readonly runner: Runner;

  constructor(
    private readonly opts: JobOptions,
    private readonly onDone: (job: Job) => void = () => {},
  ) {
    this.runner = opts.runner ?? processRunner(opts.python);
  }

  /** Queue an analysis. `out` pins the output JSON file (re-analysis of a known repo). */
  submit(source: string, { full = false, out = null }: { full?: boolean; out?: string | null } = {}): Job {
    const existing = [...this.jobs.values()].find(
      (j) => j.source === source && (j.status === "queued" || j.status === "running"),
    );
    if (existing) return existing;
    const job: Job = {
      id: randomUUID(),
      source,
      full,
      status: "queued",
      progress: "Queued",
      log: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      repoId: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.queue.push({ job, out });
    this.prune();
    void this.pump();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Resolves when nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 10));
  }

  private args(job: Job, out: string | null): string[] {
    const a = [this.opts.cliPath, "analyze", job.source, "--workdir", this.opts.workdir, "--top", "0"];
    if (out) a.push("--json", out);
    else if (this.opts.dataDir) a.push("--data-dir", this.opts.dataDir);
    else if (this.opts.mongoUrl)
      a.push("--mongo-url", this.opts.mongoUrl, "--mongo-db", this.opts.mongoDb ?? "grasp");
    if (job.full) a.push("--full");
    return a;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    const { job, out } = next;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.progress = "Starting";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30 * 60_000);
    try {
      const { code } = await this.runner(
        this.args(job, out),
        (line) => {
          job.log.push(line);
          if (job.log.length > LOG_LINES) job.log.shift();
          const m = /^\[grasp\] (.*)$/.exec(line);
          if (!m) return;
          const id = /^repo-id (\S+)$/.exec(m[1]!);
          if (id) job.repoId = id[1]!;
          else job.progress = m[1]!;
        },
        ctrl.signal,
      );
      if (code === 0) {
        job.status = "succeeded";
        job.progress = "Done";
      } else {
        job.status = "failed";
        job.error = ctrl.signal.aborted
          ? "timed out"
          : ([...job.log].reverse().find((l) => /error|fatal/i.test(l)) ?? `worker exited with code ${code}`);
      }
    } finally {
      clearTimeout(timer);
      job.finishedAt = new Date().toISOString();
      this.running = false;
      this.onDone(job);
      void this.pump();
    }
  }

  private prune(): void {
    const done = this.list().filter((j) => j.status === "succeeded" || j.status === "failed");
    for (const j of done.slice(KEEP_JOBS)) this.jobs.delete(j.id);
  }
}

/** Normalise a local path the way the worker does (resolve + forward slashes). */
export function normalisePath(p: string): string {
  const n = path.resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? n.toLowerCase() : n;
}
