import { useId } from "react";

export type Mood = "wave" | "point" | "look" | "cheer";

/**
 * Hatch, the Grasp mascot: the logo mark come alive. A small surveyor whose body is half
 * charted (solid ink) and half uncharted (hatched), carrying a survey flag.
 * Decorative by default (aria-hidden); pass `title` to give it an accessible name.
 */
export function Mascot({ size = 64, mood = "wave", title }: { size?: number; mood?: Mood; title?: string }) {
  const id = useId().replace(/:/g, "");
  const hatch = `hatch-${id}`;
  const clip = `clip-${id}`;
  // pupils glance toward what Hatch is pointing at
  const look = mood === "point" ? 2 : mood === "look" ? -2 : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className="mascot shrink-0 overflow-visible"
    >
      <defs>
        <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="5" height="5" fill="var(--surface-1)" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink)" strokeWidth="1.6" opacity="0.55" />
        </pattern>
        <clipPath id={clip}>
          <rect x="12" y="18" width="44" height="42" rx="12" />
        </clipPath>
      </defs>

      {/* survey flag */}
      <line x1="47" y1="19" x2="47" y2="3" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M47 3.5 L60 7.5 L47 11.5 Z" fill="var(--accent)" />

      {/* body: charted half + uncharted half */}
      <g clipPath={`url(#${clip})`}>
        <rect x="12" y="18" width="44" height="42" fill={`url(#${hatch})`} />
        <rect x="12" y="18" width="22" height="42" fill="var(--ink)" />
      </g>
      <rect x="12" y="18" width="44" height="42" rx="12" fill="none" stroke="var(--ink)" strokeWidth="2.4" />

      {/* eyes */}
      <g className="mascot-eyes">
        <circle cx="26" cy="35" r="6.2" fill="var(--surface-1)" />
        <circle cx="42" cy="35" r="6.2" fill="var(--surface-1)" stroke="var(--ink)" strokeWidth="1.8" />
        <circle cx={26 + look} cy="36" r="2.8" fill="var(--ink)" />
        <circle cx={42 + look} cy="36" r="2.8" fill="var(--ink)" />
      </g>

      {/* mouth */}
      {mood === "cheer" ? (
        <path
          d="M28 46 Q34 54 40 46 Z"
          fill="var(--surface-1)"
          stroke="var(--ink)"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M29 46.5 Q34 51.5 39 46.5 Q34 48.5 29 46.5 Z"
          fill="var(--surface-1)"
          stroke="var(--ink)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      )}

      {/* arms */}
      {mood === "wave" || mood === "cheer" ? (
        <path
          d="M56 40 Q64 34 63 25"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="2.6"
          strokeLinecap="round"
          className="mascot-wave"
        />
      ) : mood === "point" ? (
        <path d="M56 42 L67 38" fill="none" stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" />
      ) : (
        <path
          d="M56 44 Q61 47 60 52"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      )}
      <path d="M12 44 Q6 47 7 52" fill="none" stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" />

      {/* feet */}
      <ellipse cx="25" cy="62.5" rx="6" ry="2.6" fill="var(--ink)" />
      <ellipse cx="43" cy="62.5" rx="6" ry="2.6" fill="var(--ink)" />
    </svg>
  );
}
