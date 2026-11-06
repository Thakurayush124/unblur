import { useEffect, useState, type FormEvent } from "react";

import { api, ApiError, useApi, type Settings, type SettingsResponse } from "../api";
import { useApp } from "../App";
import { Card, Load, Notice, PageHeader } from "../components/ui";

type ListKey =
  | "aiTrailerPatterns"
  | "aiMessagePatterns"
  | "botPatterns"
  | "aiBotPatterns"
  | "aiPrLabels"
  | "ignoreGlobs"
  | "criticalPaths"
  | "criticalPathPatterns";

const LISTS: { key: ListKey; label: string; help: string }[] = [
  {
    key: "aiTrailerPatterns",
    label: "AI trailer patterns",
    help: "Regexes matched against commit messages (case-insensitive, multiline).",
  },
  { key: "aiMessagePatterns", label: "AI message patterns", help: "Regexes such as Generated with or 🤖." },
  {
    key: "botPatterns",
    label: "Bot author patterns",
    help: "Non-human accounts (dependency/CI bots), matched against “Name <email>”. Not counted as AI.",
  },
  {
    key: "aiBotPatterns",
    label: "AI agent author patterns",
    help: "Bot accounts that are AI coding agents: their commits count as AI-written.",
  },
  {
    key: "aiPrLabels",
    label: "AI PR labels",
    help: "PR labels that mark a PR as AI-generated (GitHub mode).",
  },
  {
    key: "criticalPathPatterns",
    label: "Critical path patterns",
    help: "Regexes searched in file paths. A match sets criticality to 0.9.",
  },
  {
    key: "criticalPaths",
    label: "Critical paths",
    help: "Globs for code you know is critical, such as src/ledger/. A match sets criticality to 1.0.",
  },
  {
    key: "ignoreGlobs",
    label: "Ignore globs",
    help: "Vendored or generated files to skip (name/ = any directory segment).",
  },
];
const WEIGHTS = [
  { key: "wA", label: "w_a: human-written share" },
  { key: "wR", label: "w_r: review depth" },
  { key: "wH", label: "w_h: human touch × retention" },
  { key: "wE", label: "w_e: verified understanding" },
] as const;

type Form = Required<Pick<Settings, "weights" | "llmCriticality" | "activeDays" | "riskThreshold">> &
  Record<ListKey, string>;

function toForm(s: Settings): Form {
  const form = {
    weights: s.weights ?? { wA: 0.3, wR: 0.2, wH: 0.3, wE: 0.2 },
    llmCriticality: s.llmCriticality ?? false,
    activeDays: s.activeDays ?? 90,
    riskThreshold: s.riskThreshold ?? 60,
  } as Form;
  for (const l of LISTS) form[l.key] = (s[l.key] ?? []).join("\n");
  return form;
}

function fromForm(f: Form): Settings {
  const out: Settings = {
    weights: f.weights,
    llmCriticality: f.llmCriticality,
    activeDays: f.activeDays,
    riskThreshold: f.riskThreshold,
  };
  for (const l of LISTS)
    out[l.key] = f[l.key]
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  return out;
}

const input = "w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm";

function Editor({ initial, repoId }: { initial: SettingsResponse; repoId: string }) {
  const [form, setForm] = useState(() => toForm(initial.effective));
  const [status, setStatus] = useState<{
    tone: "info" | "error";
    text: string;
    fields?: Record<string, string[]>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const sum = form.weights.wA + form.weights.wR + form.weights.wH + form.weights.wE;

  async function save(body: Settings, okText: string) {
    setSaving(true);
    try {
      const res = await api<SettingsResponse>(`/repos/${repoId}/settings`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setForm(toForm(res.effective));
      setStatus({ tone: "info", text: okText });
    } catch (e) {
      const details =
        e instanceof ApiError
          ? (e.details as { fieldErrors?: Record<string, string[]> } | undefined)
          : undefined;
      setStatus({
        tone: "error",
        text: e instanceof Error ? e.message : "Save failed",
        fields: details?.fieldErrors,
      });
    } finally {
      setSaving(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save(fromForm(form), "Saved. Changes take effect on the next analysis run.");
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-6" noValidate>
      <Card title="Scoring weights" id="w-h" variant="panel" tour="weights">
        <p className="mb-3 text-sm text-ink-2">
          comprehension = 100 × (w_a·(1−A) + w_r·R + w_h·(H·K) + w_e·E)
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {WEIGHTS.map((w) => (
            <label key={w.key} className="text-sm">
              <span className="mb-1 block text-ink-2">{w.label}</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                className={input}
                value={form.weights[w.key]}
                onChange={(e) =>
                  setForm({ ...form, weights: { ...form.weights, [w.key]: Number(e.target.value) } })
                }
              />
            </label>
          ))}
        </div>
        <p
          className={`mt-2 text-sm tabular ${Math.abs(sum - 1) > 0.001 ? "text-critical" : "text-muted"}`}
          aria-live="polite"
        >
          Sum: {sum.toFixed(2)}
          {Math.abs(sum - 1) > 0.001 && " (scores are clamped to 0–100; a sum of 1.00 keeps them comparable)"}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-ink-2">Active contributor window (days)</span>
            <input
              type="number"
              min={1}
              max={3650}
              className={input}
              value={form.activeDays}
              onChange={(e) => setForm({ ...form, activeDays: Number(e.target.value) })}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-ink-2">High-risk threshold (0–100)</span>
            <input
              type="number"
              min={0}
              max={100}
              className={input}
              value={form.riskThreshold}
              onChange={(e) => setForm({ ...form, riskThreshold: Number(e.target.value) })}
            />
          </label>
        </div>
      </Card>

      <Card title="Detection and criticality rules" id="rules-h" variant="panel">
        <div className="grid gap-4 md:grid-cols-2">
          {LISTS.map((l) => (
            <label key={l.key} className="text-sm">
              <span className="mb-1 block font-medium">{l.label}</span>
              <span id={`${l.key}-help`} className="mb-1 block text-xs text-muted">
                {l.help} One per line.
              </span>
              <textarea
                rows={4}
                className={`${input} font-mono`}
                aria-describedby={`${l.key}-help`}
                value={form[l.key]}
                aria-invalid={Boolean(status?.fields?.[l.key])}
                onChange={(e) => setForm({ ...form, [l.key]: e.target.value })}
              />
              {status?.fields?.[l.key] && (
                <span className="mt-1 block text-xs text-critical">{status.fields[l.key]!.join("; ")}</span>
              )}
            </label>
          ))}
        </div>
      </Card>

      <Card title="LLM criticality (opt-in)" id="llm-h" variant="panel">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={form.llmCriticality}
            onChange={(e) => setForm({ ...form, llmCriticality: e.target.checked })}
          />
          <span>
            <span className="font-medium">Classify file criticality with an LLM</span>
            <span className="mt-1 block text-ink-2">
              Sends only the file path, its first 60 lines and exported symbol names to the configured
              provider. Every call is logged with bytes sent. It also needs{" "}
              <code>GRASP_ALLOW_LLM_CODE=true</code> on the worker. Use a local Ollama model to keep code on
              your machine.
            </span>
          </span>
        </label>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save({}, "Overrides cleared: the repo's own config applies on the next run.")}
          className="rounded-md border border-line px-4 py-2 text-sm hover:bg-surface-2"
        >
          Clear dashboard overrides
        </button>
        <div aria-live="polite" className="min-w-0 flex-1">
          {status && <Notice tone={status.tone}>{status.text}</Notice>}
        </div>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const { repoId } = useApp();
  const state = useApi<SettingsResponse>(`/repos/${repoId}/settings`);
  const [key, setKey] = useState(0);
  useEffect(() => setKey((k) => k + 1), [state]);
  return (
    <>
      <PageHeader
        title="Settings"
        sub="Saved settings override the repo's .grasp.json and take effect on the next analysis run."
      />
      <Load state={state}>{(s) => <Editor key={key} initial={s} repoId={repoId} />}</Load>
    </>
  );
}
