import type { Page } from "../router";

export interface TourStep {
  id: string;
  page: Page;
  /** Value of the `data-tour` attribute to spotlight. */
  target: string;
  /** `{name}` is replaced with the chosen guide's name. */
  title: string;
  body: string;
  /** Needs a file path (file detail steps); skipped when the repo has no files. */
  needsFile?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "score",
    page: "overview",
    target: "score",
    title: "Hi, I'm {name}",
    body: "I'll be your guide. This takes about a minute. This number is how much of the codebase the people still on your team understand. On the bar, the solid part is understood and the hatched part is code nobody currently knows.",
  },
  {
    id: "figures",
    page: "overview",
    target: "figures",
    title: "The numbers worth watching",
    body: "Files at high risk, modules that no active person knows (bus factor 0), how much of the code was written with AI, and how many contributors are still around.",
  },
  {
    id: "trend",
    page: "overview",
    target: "trend",
    title: "Is it getting better?",
    body: "Every analysis adds a point here, so you can see whether the team's understanding is keeping up with the code being written.",
  },
  {
    id: "riskiest",
    page: "overview",
    target: "riskiest",
    title: "Start with these files",
    body: "Risk combines how critical a file is with how little it is understood. Each row says why in one sentence. Select a path to see the full story.",
  },
  {
    id: "heatmap",
    page: "heatmap",
    target: "treemap",
    title: "See where the risk lives",
    body: "Each box is a file: its size is lines of code and its colour is risk, from pale green to deep red. Select a module to zoom in. Tab and Enter work too.",
  },
  {
    id: "breakdown",
    page: "file",
    target: "breakdown",
    needsFile: true,
    title: "Why a file scores the way it does",
    body: "The bar splits the score into four parts: code written by people, how deeply it was reviewed, recent work by people still here, and verified understanding. The hatched rest is what's missing.",
  },
  {
    id: "evidence",
    page: "file",
    target: "evidence",
    needsFile: true,
    title: "Every number has evidence",
    body: "AI-written lines trace back to the commits that still own them and the reason each was flagged, such as a Co-Authored-By trailer. Nothing here is a black box.",
  },
  {
    id: "people",
    page: "people",
    target: "coverage",
    title: "Who knows what",
    body: "For each module: who still holds working knowledge, and who has left. It's a team view. Grasp never scores or ranks individual people.",
  },
  {
    id: "settings",
    page: "settings",
    target: "weights",
    title: "Make it fit your team",
    body: "Tune the scoring weights, the patterns that detect AI commits, and which paths count as critical. Changes apply on the next analysis.",
  },
  {
    id: "add",
    page: "add",
    target: "add-form",
    title: "Analyse any repository",
    body: "Paste a git URL or a local folder. Grasp clones it, reads its history and shows the results here. Your source code stays on this machine.",
  },
  {
    id: "github",
    page: "add",
    target: "github",
    title: "Guard your pull requests",
    body: "Connect the GitHub App to bring in real review data and add a check to PRs that touch high-risk code. That's the tour. Select me in the corner whenever you want to see it again.",
  },
];
