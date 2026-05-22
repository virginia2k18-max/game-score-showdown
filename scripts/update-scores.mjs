#!/usr/bin/env node
/**
 * update-scores.mjs
 *
 * Reads scores.json, queries the OpenCritic API (via RapidAPI) for each game,
 * and writes the updated scores back. Designed to run from GitHub Actions on a
 * schedule, but can also be run locally with `node scripts/update-scores.mjs`.
 *
 * Requires:
 *   - Node 18+ (uses global fetch)
 *   - Environment variable RAPIDAPI_KEY set to your OpenCritic API key
 */

import fs from "node:fs/promises";
import path from "node:path";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "opencritic-api.p.rapidapi.com";
const BASE_URL = `https://${RAPIDAPI_HOST}`;
const SCORES_PATH = path.resolve("scores.json");

const SLEEP_MS = 1500; // polite delay between API calls

if (!RAPIDAPI_KEY) {
  console.error("Error: RAPIDAPI_KEY environment variable not set.");
  console.error("If running locally, prefix the command:");
  console.error("  RAPIDAPI_KEY=your_key_here node scripts/update-scores.mjs");
  process.exit(1);
}

const headers = {
  "X-RapidAPI-Key": RAPIDAPI_KEY,
  "X-RapidAPI-Host": RAPIDAPI_HOST,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimitError extends Error {
  constructor(msg) { super(msg); this.name = "RateLimitError"; }
}

/** Fetch a game by its OpenCritic numeric ID. */
async function fetchGameById(id) {
  const res = await fetch(`${BASE_URL}/game/${id}`, { headers });
  if (res.status === 429) {
    throw new RateLimitError(`Rate limit hit fetching game ${id}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching game ${id}: ${await res.text()}`);
  }
  return res.json();
}

/** Search for a game by title; returns the closest matching ID or null. */
async function searchGameByTitle(title) {
  const url = `${BASE_URL}/game/search?criteria=${encodeURIComponent(title)}`;
  const res = await fetch(url, { headers });
  if (res.status === 429) {
    throw new RateLimitError(`Rate limit hit searching "${title}"`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} searching "${title}": ${await res.text()}`);
  }
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  // Search returns objects with `dist` (lower = better match) and `id`.
  // Use the same threshold as the reference Elixir client.
  const top = results[0];
  if (top && typeof top.dist === "number" && top.dist < 0.1 && top.id) {
    return { id: top.id, name: top.name };
  }
  return null;
}

/** Derive a status string from the API response and the known release date. */
function deriveStatus(apiResponse, knownReleaseDate) {
  const releaseDateStr =
    apiResponse.firstReleaseDate || apiResponse.releaseDate || knownReleaseDate;
  const releaseDate = releaseDateStr ? new Date(releaseDateStr) : null;
  const now = new Date();

  const hasScore =
    typeof apiResponse.topCriticScore === "number" &&
    apiResponse.topCriticScore > 0 &&
    typeof apiResponse.numTopCriticReviews === "number" &&
    apiResponse.numTopCriticReviews > 0;

  if (hasScore) return "released";
  if (releaseDate && !isNaN(releaseDate) && releaseDate < now) {
    return "released_no_score";
  }
  return "unreleased";
}

/** Normalize the API's release date to a YYYY-MM-DD string when possible. */
function normalizeReleaseDate(apiResponse, existing) {
  const raw = apiResponse.firstReleaseDate || apiResponse.releaseDate;
  if (!raw) return existing;
  // If raw looks like an ISO 8601 timestamp, slice to date.
  if (typeof raw === "string" && raw.length >= 10) {
    return raw.slice(0, 10);
  }
  return existing;
}

/** Build a public OpenCritic page URL from the API response. */
function buildUrl(apiResponse, existing) {
  if (apiResponse.id && apiResponse.name) {
    const slug = apiResponse.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `https://opencritic.com/game/${apiResponse.id}/${slug}`;
  }
  return existing;
}

async function main() {
  console.log(`Reading ${SCORES_PATH}`);
  const data = JSON.parse(await fs.readFile(SCORES_PATH, "utf-8"));

  const titles = Object.keys(data.scores);
  console.log(`Processing ${titles.length} game(s)...\n`);

  const failures = [];
  let updated = 0;
  let newIds = 0;

  for (const title of titles) {
    const entry = data.scores[title];

    try {
      // If we don't yet have an OpenCritic ID, try to find one via search.
      if (!entry.opencritic_id) {
        process.stdout.write(`🔍 ${title}\n   searching... `);
        const found = await searchGameByTitle(title);
        await sleep(SLEEP_MS);
        if (!found) {
          console.log("not found on OpenCritic yet, skipping");
          continue;
        }
        console.log(`found id ${found.id} ("${found.name}")`);
        entry.opencritic_id = found.id;
        newIds++;
      }

      process.stdout.write(`📊 ${title}\n   fetching id ${entry.opencritic_id}... `);
      const api = await fetchGameById(entry.opencritic_id);

      const status = deriveStatus(api, entry.release_date);
      const score =
        typeof api.topCriticScore === "number" && api.topCriticScore > 0
          ? Math.round(api.topCriticScore)
          : null;
      const reviewCount =
        typeof api.numTopCriticReviews === "number" ? api.numTopCriticReviews : null;
      const recommendPct =
        typeof api.percentRecommended === "number"
          ? Math.round(api.percentRecommended)
          : null;

      // Update only the API-derived fields. Preserve `note` and any other
      // manually-set fields.
      entry.score = score;
      entry.status = status;
      entry.review_count = reviewCount;
      entry.recommend_pct = recommendPct;
      entry.release_date = normalizeReleaseDate(api, entry.release_date);
      entry.url = buildUrl(api, entry.url);

      console.log(`${status}${score != null ? ` ${score}` : ""}${
        reviewCount != null ? ` (${reviewCount} critics)` : ""
      }`);
      updated++;
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.log(`✗ rate limit hit — stopping early to preserve quota`);
        console.log(`   ${err.message}`);
        failures.push(title + " (rate limited)");
        break;  // stop hitting the API; save what we have
      }
      console.log(`✗ failed: ${err.message}`);
      failures.push(title);
    }

    await sleep(SLEEP_MS);
  }

  data.lastUpdated = new Date().toISOString();
  await fs.writeFile(SCORES_PATH, JSON.stringify(data, null, 2) + "\n");

  console.log("\n──────────────────────────────────────");
  console.log(`✓ ${updated} game(s) updated`);
  if (newIds > 0) console.log(`✓ ${newIds} new OpenCritic ID(s) discovered`);
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} failure(s): ${failures.join(", ")}`);
  }
  console.log(`Wrote ${SCORES_PATH} (lastUpdated: ${data.lastUpdated})`);

  // Don't exit non-zero on partial failures — we still want to commit
  // whatever did succeed.
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
