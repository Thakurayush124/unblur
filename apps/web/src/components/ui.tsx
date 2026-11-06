import type { ReactNode } from "react";

import type { Loadable } from "../api";

export function Card({
  title,
  children,
  actions,
  id,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <section
      aria-labelledby={title && id ? id : undefined}
      className="min-w-0 rounded-xl border border-line bg-surface p-5"
    >
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 id={id} className="text-base font-semibold">
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      <div className="min-w-0 overflow-x-auto">{children}</div>
    </section>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="mt-1 text-3xl font-semibold">{value}</dd>
      {hint && <dd className="mt-1 text-xs text-muted">{hint}</dd>}
    </div>
  );
}

/** Active/departed marker: icon + label, never colour alone. */
export function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-good">
      <span aria-hidden>●</span> active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
      <span aria-hidden>○</span> departed
    </span>
  );
}

export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warn" | "error";
}) {
  const icon = tone === "error" ? "✕" : tone === "warn" ? "!" : "i";
  const color = tone === "error" ? "text-critical" : "text-ink-2";
  return (
    <div
      role={tone === "error" ? "alert" : "note"}
      className={`flex gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm ${color}`}
    >
      <span aria-hidden className="font-bold">
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function Load<T>({ state, children }: { state: Loadable<T>; children: (data: T) => ReactNode }) {
  if (state.status === "loading")
    return (
      <p role="status" className="py-10 text-center text-sm text-muted">
        Loading…
      </p>
    );
  if (state.status === "error") return <Notice tone="error">{state.error.message}</Notice>;
  return <>{children(state.data)}</>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{title}</h1>
        {sub && <p className="mt-1 text-sm text-ink-2">{sub}</p>}
      </div>
      {actions}
    </header>
  );
}

export const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted";
export const td = "px-3 py-2 align-top";
