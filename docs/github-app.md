# GitHub App setup: real review data and the PR comprehension check

Connecting Unblur to GitHub gives you two things:

1. **Real review depth (signal R).** Merged PRs and their reviews are backfilled through GraphQL, so Unblur can tell a substantive review from a 0-comment rubber stamp.
2. **The PR guard.** When a PR modifies a file whose risk is ≥ 60 (configurable in Settings), Unblur adds a **"Unblur: comprehension check"** in the `action_required` state. It also posts **one** comment (edited in place afterwards) asking the author for a `## Why this works` section. The check passes only when **both** of these are true:
   - the PR description has that section, with at least 3 sentences, **and**
   - a reviewer other than the author approves with a review that contains **`/unblur verified`**.

   PRs that touch only low-risk files always pass. Repos Unblur hasn't analysed yet get a neutral, non-blocking result.

When a PR is merged, or something is pushed to the default branch, Unblur re-analyses the repo incrementally. Only the files that changed are re-blamed.

## 1. Forward webhooks to your machine

The API listens on `127.0.0.1` only. Use a forwarder that delivers webhooks *to* localhost, rather than one that exposes the API to the internet:

```bash
# Option A: smee.io (create a channel at https://smee.io/new)
npx smee-client --url https://smee.io/<channel> --target http://127.0.0.1:4000/api/github/webhook

# Option B: GitHub CLI (requires the gh webhook extension)
gh webhook forward --repo <owner>/<repo> --events=pull_request,pull_request_review,push --url=http://127.0.0.1:4000/api/github/webhook
```

## 2. Create the App (you do this in GitHub)

Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**, and fill it in with the values from [`github-app-manifest.json`](github-app-manifest.json):

| Setting | Value |
|---|---|
| Webhook URL | your smee channel URL |
| Webhook secret | a long random string. Keep it, it becomes `GITHUB_WEBHOOK_SECRET` |
| Permissions | Contents: **Read**, Metadata: **Read**, Pull requests: **Read & write**, Checks: **Read & write** |
| Subscribe to events | Pull request, Pull request review, Push (installation events are always delivered) |
| Where can it be installed | Only on this account |

After creating it, note the **App ID** and generate a **private key** (a `.pem` file). Store the key outside the repo.

## 3. Configure Unblur

```bash
export GITHUB_APP_ID=123456
export GITHUB_PRIVATE_KEY_PATH=/secure/place/unblur.private-key.pem   # or GITHUB_PRIVATE_KEY="-----BEGIN…\n…"
export GITHUB_WEBHOOK_SECRET=<the secret from step 2>
export UNBLUR_PUBLIC_URL=http://localhost:4000      # optional: adds dashboard links to checks and comments
npm run build && node apps/api/dist/index.js
```

When it's working, the API logs `GitHub App 123456 enabled`, and the dashboard's **Add repo** page shows "Connected".

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_API_URL` / `GITHUB_GRAPHQL_URL` / `GITHUB_WEB_URL` | github.com | GitHub Enterprise Server endpoints |
| `UNBLUR_GITHUB_BACKFILL` | `300` | number of merged PRs backfilled per repo |
| `UNBLUR_GUARD_MIN_SENTENCES` | `3` | minimum sentences in `## Why this works` |

## 4. Install it on a repository

Install the App on a sandbox repo. Unblur then:
1. backfills merged PRs and reviews into `data/.github/<owner>-<repo>.prs.json`,
2. clones the repo with a short-lived installation token (passed to git through environment variables, never written to `.git/config` or logs), and analyses it,
3. adds the comprehension check to every PR from then on.

### Sandbox checklist (manual end-to-end test)

1. Open a PR that changes only a low-risk file (for example a README). **Expect:** the check is ✅ and there's no comment.
2. Open a PR that changes a high-risk file (see the dashboard heatmap). **Expect:** the check shows *Action required* and Unblur posts one comment.
3. Add `## Why this works` with 3 or more sentences to the description. **Expect:** the check and the comment update, and it's still blocked.
4. Approve the PR as the author with `/unblur verified`. **Expect:** still blocked, because self-verification doesn't count.
5. Approve as a different user with `/unblur verified`. **Expect:** the check is ✅ and the comment says it passed.
6. Merge it. **Expect:** the dashboard shows the new analysis and the PR's review data within about a minute.

To make the check actually block merging, add **"Unblur: comprehension check"** as a required status check in the repo's branch protection rules.

## Privacy

Unblur sends nothing to GitHub except check runs and the one comment. Source code stays on your machine. Webhook payloads are verified with HMAC-SHA256 (`X-Hub-Signature-256`) before they're parsed, and redeliveries are ignored.
