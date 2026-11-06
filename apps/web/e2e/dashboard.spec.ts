import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

async function useRepo(page: Page, id: string, theme = "light") {
  await page.addInitScript(
    ([repo, t]) => {
      // Seed once per test (each test has a fresh context), so reloads keep user changes.
      if (localStorage.getItem("grasp-e2e-seeded")) return;
      localStorage.setItem("grasp-e2e-seeded", "1");
      localStorage.setItem("grasp-repo", repo!);
      localStorage.setItem("grasp-theme", t!);
      localStorage.setItem("grasp-tour-seen", "1"); // the first-visit tour has its own spec
    },
    [id, theme],
  );
}

test.describe("demo repo", () => {
  test.beforeEach(async ({ page }) => {
    await useRepo(
      page,
      (await (await page.request.get("/api/repos")).json()).find(
        (r: { name: string }) => r.name === "demo-repo",
      ).id,
    );
  });

  test("overview shows scores, trend and riskiest files with explanations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "demo-repo" })).toBeVisible();
    await expect(page.getByText("Comprehension", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Trend" })).toBeVisible();
    const top = page.getByRole("table", { name: "Ten riskiest files with explanations" });
    await expect(top.getByRole("row")).toHaveCount(11);
    await expect(top).toContainText("100% AI-written");
    await expect(page.getByText("Review data unavailable")).toHaveCount(0); // demo ships PR data
  });

  test("keyboard: nav → heatmap module → file detail", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Heatmap" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Heatmap" })).toBeVisible();

    const auth = page.getByRole("link", { name: /^src\/auth: risk/ });
    await auth.focus();
    await expect(page.getByRole("tooltip")).toContainText("src/auth");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "src/auth" })).toBeVisible();

    const tokens = page.getByRole("link", { name: /^src\/auth\/tokens\.py: risk/ });
    await tokens.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "src/auth/tokens.py" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Score breakdown" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Signal breakdown" })).toContainText("Review depth (R)");
    await expect(page.getByText("Co-Authored-By: Claude").first()).toBeVisible();
    await expect(page.getByRole("table", { name: "Owners of current lines" })).toContainText("departed");
  });

  test("heatmap has a table alternative", async ({ page }) => {
    await page.goto("/#/heatmap");
    await page.getByRole("button", { name: "Show as table" }).click();
    await expect(page.getByRole("table", { name: "Modules by risk" })).toContainText("src/billing");
  });

  test("people page lists bus-factor-0 modules without ranking people", async ({ page }) => {
    await page.goto("/#/people");
    await expect(page.getByRole("note").filter({ hasText: "bus factor 0" })).toContainText("src/auth");
    const table = page.getByRole("table", { name: /Knowledge holders per module/ });
    await expect(table).toContainText("Marco Rossi");
    await expect(table.getByRole("columnheader")).toHaveText([
      "Module",
      "Bus factor",
      "Active knowledge holders",
      "Departed holders",
      "Risk",
      "AI share",
    ]);
  });

  test("settings: validation errors, then save", async ({ page }) => {
    await page.goto("/#/settings");
    const patterns = page.getByRole("textbox", { name: /AI message patterns/ });
    await patterns.fill("Generated with\n(unclosed");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("alert")).toContainText("invalid settings");
    await expect(page.getByText("not a valid regular expression")).toBeVisible();

    await patterns.fill("Generated with\n\\[ai\\]");
    await page.getByRole("checkbox", { name: /Classify file criticality/ }).check();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("note").filter({ hasText: "Saved." })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: /AI message patterns/ })).toHaveValue(
      "Generated with\n\\[ai\\]",
    );
    await expect(page.getByRole("checkbox", { name: /Classify file criticality/ })).toBeChecked();
    await page.getByRole("button", { name: "Clear dashboard overrides" }).click();
    await expect(page.getByRole("checkbox", { name: /Classify file criticality/ })).not.toBeChecked();
  });

  test("dark mode toggle", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(14, 22, 32)"); // --page in dark mode (#0e1620)
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("add repository", () => {
  test("rejects an unsupported source with a clear message", async ({ page }) => {
    await page.goto("/#/add");
    await page.getByRole("textbox").fill("ftp://example.com/repo");
    await page.getByRole("button", { name: "Analyse repository" }).click();
    await expect(page.getByRole("alert")).toContainText("Unsupported URL");
  });

  test("analyses a local checkout end to end and opens its overview", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/#/add");
    await expect(page.getByRole("heading", { level: 1, name: "Add a repository" })).toBeVisible();
    await page.getByRole("textbox").fill(path.resolve("e2e/.data/sample-repo"));
    await page.getByRole("button", { name: "Analyse repository" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "sample-repo" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByRole("combobox").first()).toHaveValue(/.+/);
    await expect(page.getByRole("table", { name: "Ten riskiest files with explanations" })).toContainText(
      "src/auth.py",
    );
    // re-analyse from the overview (incremental)
    await page.getByRole("button", { name: "Re-analyse" }).click();
    await expect(page.getByRole("button", { name: "Re-analyse" })).toBeEnabled({ timeout: 45_000 });
  });
});

test.describe("5,000-file repo", () => {
  test.beforeEach(async ({ page }) => useRepo(page, "r_large"));

  for (const [name, url, ready] of [
    ["overview", "/", "Top 10 riskiest files"],
    ["heatmap", "/#/heatmap", "src/mod"],
  ] as const) {
    test(`${name} loads in < 2s`, async ({ page }) => {
      const t0 = Date.now();
      await page.goto(url);
      if (name === "overview") await expect(page.getByRole("heading", { name: ready })).toBeVisible();
      else await expect(page.locator("svg g[role=link]").first()).toBeVisible();
      const ms = Date.now() - t0;
      console.log(`${name} (5k files): ${ms} ms`);
      expect(ms).toBeLessThan(2000);
    });
  }

  test("all 5,000 files render in the treemap", async ({ page }) => {
    await page.goto("/#/heatmap");
    await expect(page.locator("svg g.cursor-pointer")).toHaveCount(5000);
  });
});
