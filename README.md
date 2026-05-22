# Game Score Showdown — Auto-Updating Scoreboard

A self-updating OpenCritic scoreboard for a year-long competition between two players. Runs on free tiers of GitHub, Netlify, and RapidAPI.

## How it works

- **`index.html`** — the page your friend opens. Fetches data from `scores.json`.
- **`scores.json`** — the data. Player picks plus current OpenCritic scores.
- **`scripts/update-scores.mjs`** — the update script. Calls the OpenCritic API for each game.
- **`.github/workflows/update-scores.yml`** — runs the script on two schedules:
  - **Weekly** (every Sunday 12:00 UTC) — always runs a full update
  - **Daily** (every day 20:00 UTC / 3pm EST) — runs only if a game is within its release window or still waiting for an OpenCritic aggregate score

  This keeps API usage minimal on quiet days while catching new release reviews on the day they drop. Commits any score changes back to the repo; Netlify picks up the commit and re-deploys.

Net effect: scores refresh on their own. You never touch anything unless you want to add a game or change a pick.

## One-time setup

### 1. Get a RapidAPI key for the OpenCritic API

1. Sign up at [rapidapi.com](https://rapidapi.com) (free).
2. Go to the [OpenCritic API page](https://rapidapi.com/opencritic-opencritic-default/api/opencritic-api).
3. Click **Subscribe to Test** and choose the **BASIC** (free) plan. A credit card is required even for the free tier; you won't be charged unless you exceed the quota.
4. Copy your `X-RapidAPI-Key` from the API dashboard. Keep it private.

### 2. Push this code to a GitHub repo

1. Create a GitHub account if you don't have one.
2. Create a new **public** repository (public repos get unlimited free Actions minutes).
3. Upload these files to it. Easiest path: on the new repo page, click "uploading an existing file" and drag everything in.

### 3. Add your API key as a GitHub secret

1. In your repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
2. Name it exactly `RAPIDAPI_KEY`.
3. Paste your key from step 1 and save.

The workflow reads from this secret. It is never written to logs or committed to the repo.

### 4. Connect Netlify to the repo

1. Sign in to Netlify and click **Add new site → Import an existing project**.
2. Choose GitHub and authorize, then pick this repo.
3. Build settings: leave **Build command** blank and **Publish directory** as `.` (a single dot, meaning repo root).
4. Click **Deploy site**.

Every push to your `main` branch — including the auto-commits from the workflow — will trigger a redeploy.

### 5. Test it

In your repo, go to **Actions → Update OpenCritic Scores → Run workflow** to trigger it manually. You should see it pick up game data and either commit nothing (if scores haven't changed) or commit an updated `scores.json`.

If the workflow fails, click into the run and check the logs.

## Editing the lineup

Open `scores.json` directly in GitHub's web editor. The structure is:

```json
{
  "players": {
    "you": {
      "name": "YourUsername",
      "main": { "open_world": "Game Title", ... },
      "alternates": ["Alt Game Title"]
    },
    ...
  },
  "scores": {
    "Game Title": {
      "opencritic_id": null,
      "score": null,
      "status": "unreleased",
      ...
    }
  }
}
```

When you add a new game:

1. Add the title to the player's `main` or `alternates` list.
2. Add a matching entry under `scores` with `opencritic_id: null` and `status: "unreleased"`.
3. Commit the change.

The next time the workflow runs, the script searches OpenCritic by title, finds the game's ID, and fills in everything automatically. You don't need to look up IDs yourself.

## Manually triggering an update

Anytime you want to refresh scores between scheduled runs (e.g. a big release just dropped): go to **Actions → Update OpenCritic Scores → Run workflow → Run workflow**. Takes about a minute.

## Local development

If you want to run the script locally before pushing:

```bash
RAPIDAPI_KEY=your_key_here node scripts/update-scores.mjs
```

Requires Node 18+. The script will update `scores.json` in place.

## Free tier limits

- **GitHub Actions**: unlimited minutes on public repos.
- **Netlify**: 100 GB bandwidth/month on the Starter plan — nowhere close for a personal scoreboard.
- **RapidAPI OpenCritic BASIC**: actual quota varies — check the subscribe page when signing up. The conditional daily check is designed to keep usage low: typically about 12 calls per active run, with most days skipping the API entirely. Realistic annual usage is around 1,000–1,500 calls across weekly + release-day runs combined. If you find the free tier is too tight, you can either disable the daily cron (just remove the `"0 20 * * *"` line from the workflow) or upgrade to the next paid tier.

## Troubleshooting

**Workflow fails with "RAPIDAPI_KEY environment variable not set"**
You didn't add the secret, or you named it something other than `RAPIDAPI_KEY`. Re-check **Settings → Secrets and variables → Actions**.

**Workflow fails with HTTP 429 or quota error**
You've hit the RapidAPI rate limit. Wait 24 hours or check your RapidAPI usage dashboard.

**Workflow runs but nothing commits**
That's fine — it means no scores changed since the last run. Check the workflow logs to confirm.

**A game is listed but not getting a score even though it's released**
Check `scores.json` and look at the entry. If `opencritic_id` is `null`, the script's title search didn't find a close enough match. Look the game up on OpenCritic manually, copy its numeric ID from the URL (`opencritic.com/game/{ID}/...`), and paste it into the entry. Next run will pick it up.
