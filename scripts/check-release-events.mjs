#!/usr/bin/env node
/**
 * check-release-events.mjs
 *
 * Reads scores.json and decides whether the daily run should actually call
 * the OpenCritic API. Writes `should_update=true|false` to $GITHUB_OUTPUT.
 *
 * Trigger rules:
 *   - Weekly cron (Sunday 12:00 UTC) → always update.
 *   - Manual trigger (workflow_dispatch) → always update.
 *   - Daily cron → only update if any game's release_date is in the active
 *     review window (-1 day to +5 days after release), or if a game is still
 *     in "released_no_score" status within 30 days of release.
 *
 * This keeps API usage low while still catching new releases the day reviews drop.
 */

import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";

const SCORES_PATH = "scores.json";
const WEEKLY_CRON = "0 12 * * 0";
const DAY_MS = 86_400_000;

const RELEASE_WINDOW_DAYS_BEFORE = 1;   // start polling 1 day before release
const RELEASE_WINDOW_DAYS_AFTER = 5;    // continue polling 5 days after
const PENDING_SCORE_MAX_DAYS = 30;      // give up after 30 days if OC never aggregates

const eventName = process.env.GITHUB_EVENT_NAME || "manual";
const cronExpression = process.env.GITHUB_EVENT_SCHEDULE || "";

console.log(`Trigger: ${eventName}${cronExpression ? ` (cron: ${cronExpression})` : ""}`);

let shouldUpdate = false;
const reasons = [];

if (eventName === "workflow_dispatch") {
  shouldUpdate = true;
  reasons.push("Manual trigger");
} else if (eventName === "schedule" && cronExpression === WEEKLY_CRON) {
  shouldUpdate = true;
  reasons.push("Weekly scheduled run");
} else {
  // Daily check — only update when something interesting is happening.
  const data = JSON.parse(await fs.readFile(SCORES_PATH, "utf-8"));
  const now = Date.now();

  for (const [title, entry] of Object.entries(data.scores)) {
    if (!entry.release_date) continue;

    // Parse only if release_date is a full date (YYYY-MM-DD). Coarser
    // entries like "2026" or "2026-10" don't give us a precise day,
    // so skip them — they'll be caught by the weekly run.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.release_date)) continue;

    const releaseDate = new Date(entry.release_date + "T12:00:00Z");
    if (isNaN(releaseDate)) continue;

    const daysSinceRelease = Math.round((now - releaseDate.getTime()) / DAY_MS);

    // Active release window: just before through several days after.
    if (
      daysSinceRelease >= -RELEASE_WINDOW_DAYS_BEFORE &&
      daysSinceRelease <= RELEASE_WINDOW_DAYS_AFTER
    ) {
      shouldUpdate = true;
      reasons.push(`"${title}" in release window (day ${daysSinceRelease})`);
      continue;
    }

    // Released but no Top Critic Average yet — early review days.
    if (
      entry.status === "released_no_score" &&
      daysSinceRelease > 0 &&
      daysSinceRelease <= PENDING_SCORE_MAX_DAYS
    ) {
      shouldUpdate = true;
      reasons.push(`"${title}" score pending (day ${daysSinceRelease})`);
    }
  }
}

if (shouldUpdate) {
  console.log("\n✓ Update warranted:");
  reasons.forEach((r) => console.log(`  • ${r}`));
} else {
  console.log("\n✗ No release events today — skipping API update.");
}

const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  appendFileSync(outputFile, `should_update=${shouldUpdate}\n`);
}
