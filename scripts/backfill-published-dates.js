/**
 * ONE-TIME backfill: for every currently live app, find its true
 * first-published date via the /app/{appId}/changelog endpoint (the
 * earliest changelog entry's createdAt -- e.g.
 * https://apps-api.athom.com/api/v1/app/com.athom.screenshot/changelog),
 * and use that to (re)build homey-apps-snapshot.json with a correct
 * publishedAt, sorted old -> new.
 *
 * This is NOT part of the scheduled workflow -- run it once by hand.
 * It does 2 requests per app (detail + changelog), so for a store with
 * several hundred apps this takes a while. Going forward,
 * snapshot-homey-apps.js already sets an accurate publishedAt (the
 * app's stateChangedAt at the moment it's first discovered) for any
 * NEW app, so you shouldn't need to run this again unless you want to
 * redo the whole history.
 *
 * Run with:
 *   node scripts/backfill-published-dates.js
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://apps-api.athom.com/api/v1';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'homey-apps-snapshot.json');
const CONCURRENCY = 6;

async function fetchAppIds() {
  const res = await fetch(`${BASE_URL}/app/ids`);
  if (!res.ok) throw new Error(`Failed to fetch app IDs: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchAppDetail(id) {
  try {
    const res = await fetch(`${BASE_URL}/app/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Earliest changelog entry's createdAt = closest we can get to a true
// first-publish date (stateChangedAt only reflects the MOST RECENT
// publish/update, which is what caused the original data-quality issue).
//
// The endpoint returns an OBJECT keyed by version string, e.g.
//   { "1.0.3": { state, changelog, createdAt }, "1.0.5": { ... } }
// not an array -- so this reads Object.values() rather than assuming
// an array shape.
async function fetchFirstPublishedDate(id) {
  try {
    const res = await fetch(`${BASE_URL}/app/${encodeURIComponent(id)}/changelog`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    const entries = Array.isArray(data) ? data : Object.values(data);
    const dates = entries.map((e) => e && e.createdAt).filter(Boolean).sort();
    return dates[0] || null;
  } catch {
    return null;
  }
}

function communityTopicIdFromApiObject(app) {
  const candidates = [
    app.homeyCommunityTopicId,
    app.communityTopicId,
    app.liveBuild && app.liveBuild.homeyCommunityTopicId,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && /^\d+$/.test(c)) return Number(c);
  }
  return null;
}

function simplify(app, publishedAt) {
  const build = app.liveBuild || {};
  const author = app.author || {};
  return {
    appId: app.id || '',
    name: (build.name && (build.name.en || Object.values(build.name)[0])) || '',
    developerName: author.name || '',
    developerId: author.id || '',
    version: app.liveVersion || '',
    sourceRepository: build.source || '',
    // Prefer the changelog-derived first-publish date; fall back to
    // stateChangedAt (most recent update) only if the changelog lookup failed.
    publishedAt: publishedAt || app.stateChangedAt || '',
    communityTopicId: communityTopicIdFromApiObject(app),
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('Fetching current live app IDs...');
  const ids = await fetchAppIds();
  console.log(`Found ${ids.length} apps. Fetching details + first-published date for each (2 requests per app, concurrency ${CONCURRENCY})...`);

  const results = [];
  let nextIndex = 0;
  let completed = 0;
  let missingChangelog = 0;

  async function worker() {
    while (nextIndex < ids.length) {
      const i = nextIndex++;
      const id = ids[i];
      const [detail, firstPublished] = await Promise.all([fetchAppDetail(id), fetchFirstPublishedDate(id)]);
      if (detail) {
        if (!firstPublished) missingChangelog++;
        results.push(simplify(detail, firstPublished));
      } else {
        console.warn(`  Warning: could not fetch details for "${id}". Skipping.`);
      }
      completed++;
      if (completed % 50 === 0) {
        console.log(`  ${completed} / ${ids.length} processed...`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  results.sort((a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0));

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Done. Wrote ${results.length} apps to ${path.relative(process.cwd(), SNAPSHOT_FILE)}, sorted old -> new by first-published date.`);
  if (missingChangelog > 0) {
    console.log(`Note: ${missingChangelog} app(s) had no usable changelog data, so their publishedAt fell back to stateChangedAt (last update, not first publish).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});