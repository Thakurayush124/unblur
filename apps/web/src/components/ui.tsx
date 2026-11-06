import type { ReactNode } from "react";

import type { Loadable } from "../api";

/**
 * A titled block. "section" (default) is open: a heading over a hairline, no box, so reading
 * content isn't chopped into identical cards. "panel" is a bordered surface, kept for forms and
 * interactive controls.
 */
export function Card({
  title,
  children,
  actions,
  id,
  variant = "section",
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  id?: string;
  variant?: "section" | "panel";
}) {
  const box =
    variant === "panel" ? "rounded-lg border border-line bg-surface p-5 sm:p-6" : "border-t border-rule pt-4";
  return (
    <section aria-labelledby={title && id ? id : undefined} className={`min-w-0 ${box}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          {title && (
            <h2 id={id} className="t-h2">
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

/** One figure in a row of figures (wrap several in <Figures>). */
export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 border-l border-rule pl-4">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="t-figure mt-1">{value}</dd>
      {hint && <dd className="mt-1 text-sm text-muted">{hint}</dd>}
    </div>
  );
}

export function Figures({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-6 gap-y-6 ${cols === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      {children}
    </dl>
  );
}

/** Active/departed marker: symbol + word, never colour alone. */
export function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1.5 text-sm text-good">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-current" /> active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full border border-current" /> departed
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
  const bar = tone === "error" ? "border-critical" : tone === "warn" ? "border-accent" : "border-rule";
  const text = tone === "error" ? "text-critical" : "text-ink-2";
  return (
    <div
      role={tone === "error" ? "alert" : "note"}
      className={`border-l-[3px] ${bar} bg-surface px-4 py-2.5 text-sm ${text}`}
    >
      {children}
    </div>
  );
}

export function Load<T>({ state, children }: { state: Loadable<T>; children: (data: T) => ReactNode }) {
  if (state.status === "loading")
    return (
      <p role="status" className="py-16 text-sm text-muted">
        Loading…
      </p>
    );
  if (state.status === "error") return <Notice tone="error">{state.error.message}</Notice>;
  return <>{children(state.data)}</>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        <h1 className="t-h1 [overflow-wrap:anywhere]">{title}</h1>
        {sub && <p className="mt-2 text-ink-2">{sub}</p>}
      </div>
      {actions}
    </header>
  );
}

export const th =
  "whitespace-nowrap border-b border-rule px-3 py-2 text-left text-sm font-medium text-ink-2 first:pl-0";
export const td = "px-3 py-2.5 align-top first:pl-0";

export const button = {
  primary:
    "inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50",
  secondary:
    "inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3.5 py-2 text-sm hover:bg-surface-2 disabled:opacity-50",
};
export const input = "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm";
