import { sheets, type GuideCharacter } from "./characters";

/**
 * A still pose from a character's sheet, for places where the interactive (button) mascot
 * can't go, such as inside another button. Decorative: the surrounding control is labelled.
 * Cells: directions 0-8 (4 = facing forward), reactions 0-8 (8 = delighted).
 */
export function Portrait({
  character,
  size = 40,
  sheet = "directions",
  cell = 4,
}: {
  character: GuideCharacter;
  size?: number;
  sheet?: "directions" | "reactions";
  cell?: number;
}) {
  const src = sheets(character.id)[sheet];
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${src})`,
        backgroundSize: "300% 300%",
        backgroundRepeat: "no-repeat",
        backgroundPosition: `${(cell % 3) * 50}% ${Math.floor(cell / 3) * 50}%`,
      }}
    />
  );
}
