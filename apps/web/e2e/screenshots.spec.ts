import { test } from "@playwright/test";

// Regenerates the README screenshots:  GRASP_SCREENSHOTS=1 npx playwright test screenshots
test.skip(!process.env.GRASP_SCREENSHOTS, "set GRASP_SCREENSHOTS=1 to regenerate docs/screenshots");

const OUT = "../../docs/screenshots";
const shots: [string, string, "light" | "dark"][] = [
  ["overview", "/#/overview", "light"],
  ["heatmap", "/#/heatmap", "dark"],
  ["file-detail", "/#/file?path=src%2Fauth%2Ftokens.py", "light"],
  ["people", "/#/people", "dark"],
];

for (const [name, url, theme] of shots) {
  test(`screenshot ${name}`, async ({ page, request }) => {
    const repos = (await (await request.get("/api/repos")).json()) as { id: string; name: string }[];
    const demo = repos.find((r) => r.name === "demo-repo")!;
    await page.addInitScript(
      ([id, t]) => {
        localStorage.setItem("grasp-repo", id!);
        localStorage.setItem("grasp-theme", t!);
      },
      [demo.id, theme],
    );
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(url);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: name !== "file-detail" });
  });
}
