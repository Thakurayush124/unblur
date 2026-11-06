import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "unblur-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function resolve(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return media().matches ? "dark" : "light";
}

/** Theme choice persisted in localStorage; `dark` is the resolved mode (for chart colours). */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(
    () => (localStorage.getItem(KEY) as ThemeChoice | null) ?? "system",
  );
  const [dark, setDark] = useState(() => resolve(choice) === "dark");

  useEffect(() => {
    const apply = () => {
      const mode = resolve(choice);
      document.documentElement.dataset.theme = mode;
      setDark(mode === "dark");
    };
    apply();
    localStorage.setItem(KEY, choice);
    const m = media();
    m.addEventListener("change", apply);
    return () => m.removeEventListener("change", apply);
  }, [choice]);

  return { choice, setChoice, dark };
}
