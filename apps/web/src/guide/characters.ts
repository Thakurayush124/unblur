import { useEffect, useState } from "react";

/**
 * Guide characters from page-mascot (https://github.com/nilbuild/page-mascot, MIT, Kamran Ahmed).
 * Sprite sheets live in public/mascots; see public/mascots/README.md for the credit.
 */
export interface GuideCharacter {
  id: string;
  name: string;
  /** Short description for the picker. */
  kind: string;
}

export const CHARACTERS: GuideCharacter[] = [
  { id: "owl", name: "Ollie", kind: "owl" },
  { id: "fox", name: "Fenn", kind: "fox" },
  { id: "cat", name: "Miso", kind: "cat" },
  { id: "penguin", name: "Pip", kind: "penguin" },
  { id: "otter", name: "Tide", kind: "otter" },
  { id: "scout", name: "Scout", kind: "robot" },
];

export const DEFAULT_CHARACTER = "owl";
const KEY = "unblur-guide";
const EVENT = "unblur-guide-change";

export function sheets(id: string) {
  const base = `${import.meta.env.BASE_URL}mascots/${id}`;
  return { directions: `${base}-directions.webp`, reactions: `${base}-reactions.webp` };
}

function read(): GuideCharacter {
  const id = localStorage.getItem(KEY) ?? DEFAULT_CHARACTER;
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]!;
}

export function setGuide(id: string): void {
  localStorage.setItem(KEY, id);
  window.dispatchEvent(new Event(EVENT));
}

/** The chosen guide, kept in sync across components (and tabs). */
export function useGuide(): GuideCharacter {
  const [guide, set] = useState(read);
  useEffect(() => {
    const update = () => set(read());
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return guide;
}
