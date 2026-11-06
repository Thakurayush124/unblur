import { z } from "zod";

/**
 * Settings the dashboard can edit. Keys match the worker's GraspConfig (camelCase), so the
 * saved object is passed to the worker as config overrides on its next run.
 */
function isValidRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

const regex = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(isValidRegex, { message: "not a valid regular expression" });
const glob = z.string().trim().min(1).max(500);
const weight = z.number().min(0).max(1);

export const SettingsSchema = z
  .object({
    weights: z
      .object({ wA: weight, wR: weight, wH: weight, wE: weight })
      .refine((w) => w.wA + w.wR + w.wH + w.wE > 0, { message: "at least one weight must be > 0" }),
    aiTrailerPatterns: z.array(regex).max(50),
    aiMessagePatterns: z.array(regex).max(50),
    botPatterns: z.array(regex).max(50),
    aiBotPatterns: z.array(regex).max(50),
    aiPrLabels: z.array(z.string().trim().min(1).max(100)).max(50),
    ignoreGlobs: z.array(glob).max(200),
    criticalPaths: z.array(glob).max(200),
    criticalPathPatterns: z.array(regex).max(50),
    llmCriticality: z.boolean(),
    activeDays: z.number().int().min(1).max(3650),
    riskThreshold: z.number().min(0).max(100),
  })
  .partial()
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

export const SETTING_KEYS = Object.keys(SettingsSchema.shape) as (keyof Settings)[];

/** Effective settings = worker's last-used config, with saved dashboard overrides on top. */
export function effectiveSettings(workerConfig: Record<string, unknown> | null, saved: Settings): Settings {
  const base: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    if (!workerConfig || !(k in workerConfig)) continue;
    // Per-key parse: one value the JS side can't validate (e.g. a Python-only regex) must not
    // hide every other setting.
    const parsed = SettingsSchema.shape[k].safeParse(workerConfig[k]);
    if (parsed.success) base[k] = parsed.data;
  }
  return { ...(base as Settings), ...saved };
}
