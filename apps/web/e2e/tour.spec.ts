import { expect, test, type Page } from "@playwright/test";

const TITLES = [
  "Hi, I'm Ollie",
  "The numbers worth watching",
  "Is it getting better?",
  "Start with these files",
  "See where the risk lives",
  "Why a file scores the way it does",
  "Every number has evidence",
  "Who knows what",
  "Make it fit your team",
  "Analyse any repository",
  "Guard your pull requests",
];
const PAGES = [
  "overview",
  "overview",
  "overview",
  "overview",
  "heatmap",
  "file",
  "file",
  "people",
  "settings",
  "add",
  "add",
];

async function openDemo(page: Page, theme = "light") {
  const repos = (await (await page.request.get("/api/repos")).json()) as { id: string; name: string }[];
  const demo = repos.find((r) => r.name === "demo-repo")!;
  await page.addInitScript(
    ([id, t]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("grasp-repo", id!);
      localStorage.setItem("grasp-theme", t!);
    },
    [demo.id, theme],
  );
}

test("first visit: the guide walks through every section, then hands back control", async ({ page }) => {
  test.setTimeout(60_000);
  await openDemo(page);
  await page.goto("/");
  const dialog = page.getByRole("dialog");
  for (let i = 0; i < TITLES.length; i++) {
    await expect(dialog.getByRole("heading", { name: TITLES[i] })).toBeVisible();
    await expect(dialog).toContainText(`Step ${i + 1} of ${TITLES.length}`);
    const hash = new URL(page.url()).hash;
    if (PAGES[i] === "overview") expect(["", "#/overview"]).toContain(hash.split("?")[0]);
    else expect(hash).toContain(`#/${PAGES[i]}`);
    // the highlighted section is on screen
    if (i === 0) await expect(page.locator('[data-tour="score"]')).toBeInViewport();
    if (i === 4) await expect(page.locator('[data-tour="treemap"]')).toBeInViewport({ ratio: 0.3 });
    if (process.env.GRASP_SCREENSHOTS && [0, 4, 5, 7].includes(i)) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../../docs/screenshots/tour-step-${i + 1}.png` });
    }
    await dialog.getByRole("button", { name: i === TITLES.length - 1 ? "Finish tour" : "Next" }).click();
  }
  await expect(dialog).toHaveCount(0);
  // seen: a reload does not start it again; the launcher does
  await page.goto("/#/overview");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Take the guided tour with Ollie" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Hi, I'm Ollie" })).toBeVisible();
});

test("keyboard: focus moves into the tour, arrows step, Esc closes and restores focus", async ({ page }) => {
  await openDemo(page, "dark");
  await page.goto("/");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Hi, I'm Ollie" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("heading", { name: "The numbers worth watching" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("heading", { name: "Hi, I'm Ollie" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  const launcher = page.getByRole("button", { name: "Take the guided tour with Ollie" });
  await launcher.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Skip tour" })).toBeVisible();
  await dialog.getByRole("button", { name: "Skip tour" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
});

test("guide picker: choose another character, then the tour uses it", async ({ page }) => {
  await openDemo(page);
  await page.addInitScript(() => localStorage.setItem("grasp-tour-seen", "1"));
  await page.goto("/#/settings");
  const picker = page.getByRole("group", { name: /Pick who walks you through Grasp/ });
  await expect(picker.getByRole("radio")).toHaveCount(6);
  await expect(picker.getByRole("radio", { name: /Ollie/ })).toBeChecked();
  await picker.getByText("Fenn").click();
  await expect(picker.getByRole("radio", { name: /Fenn/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Take the guided tour with Fenn" })).toBeVisible();
  // the sprite sheet actually loads
  const res = await page.request.get("/mascots/fox-directions.webp");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/webp");

  await page.getByRole("button", { name: "Take the tour with Fenn" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Hi, I'm Fenn" })).toBeVisible();
  // the interactive page-mascot character is in the panel and can be booped
  await dialog.getByRole("button", { name: "Boop the Fenn the fox" }).click();
  await expect(dialog.getByRole("heading", { name: "Hi, I'm Fenn" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Take the guided tour with Fenn" })).toBeVisible();
});
