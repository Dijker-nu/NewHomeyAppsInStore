/**
 * Snapshot the Homey App Store list and report NEW apps since the
 * last run. Designed to run in CI (e.g. GitHub Actions), where the
 * data/ directory is checked out from and committed back to the repo
 * so state persists between runs.
 *
 * NOTE: /app/all turns out to return thin objects (little more than
 * IDs), not the full per-app detail (name, version, author, source,
 * etc). The only endpoint confirmed to return that detail is
 * /app/{appId} for a single app. So this fetches the full ID list
 * from /app/ids (confirmed to return a plain array of ID strings),
 * then fetches full details per app with a small concurrency pool.
 * That means one request per app instead of one request total, so
 * a full run takes noticeably longer than it used to.
 *
 * Reads/writes (relative to the repo root, or $DATA_DIR if set):
 *   data/homey-apps-snapshot.json  - full snapshot of the current app list (overwritten each run)
 *   data/homey-new-apps-log.csv    - running log of newly-discovered apps, appended each run
 *
 * Run with:
 *   node scripts/snapshot-homey-apps.js
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://apps-api.athom.com/api/v1';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'homey-apps-snapshot.json');
const NEW_APPS_LOG = path.join(DATA_DIR, 'homey-new-apps-log.csv');
const DETAIL_CONCURRENCY = 8; // number of /app/{appId} requests in flight at once

async function fetchAppIds() {
  const res = await fetch(`${BASE_URL}/app/ids`);
  if (!res.ok) {
    throw new Error(`Failed to fetch app IDs: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchAppDetail(id) {
  try {
    const res = await fetch(`${BASE_URL}/app/${encodeURIComponent(id)}`);
    if (!res.ok) {
      console.warn(`  Warning: failed to fetch details for "${id}" (${res.status} ${res.statusText}). Skipping it this run.`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`  Warning: error fetching details for "${id}" (${err.message}). Skipping it this run.`);
    return null;
  }
}

async function fetchAllApps() {
  const ids = await fetchAppIds();
  console.log(`Found ${ids.length} live app IDs. Fetching full details for each (one request per app)...`);

  const results = [];
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < ids.length) {
      const i = nextIndex++;
      const detail = await fetchAppDetail(ids[i]);
      if (detail) results.push(detail);
      completed++;
      if (completed % 100 === 0) {
        console.log(`  ${completed} / ${ids.length} app details fetched...`);
      }
    }
  }

  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  return results;
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

async function communityTopicIdFromAppPage(appId) {
  try {
    const res = await fetch(`https://homey.app/a/${encodeURIComponent(appId)}`);
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/community\.homey\.app\/t\/(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function simplify(app) {
  const build = app.liveBuild || {};
  const author = app.author || {};
  return {
    appId: app.id || '',
    name: (build.name && (build.name.en || Object.values(build.name)[0])) || '',
    developerName: author.name || '',
    developerId: author.id || '',
    version: app.liveVersion || '',
    sourceRepository: build.source || '',
    publishedAt: app.stateChangedAt || '',
    // Cheap check only (no network) -- most apps won't have this field
    // exposed via the API, so it'll often be null here. Newly-detected
    // apps get a more thorough check (with a homey.app page fallback)
    // further down in main(), since that's a much smaller volume of
    // per-app network requests to spend on the scrape fallback.
    communityTopicId: communityTopicIdFromApiObject(app),
  };
}

function loadPreviousSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch (err) {
    console.warn(`Warning: could not read/parse existing snapshot (${err.message}). Treating this as a first run.`);
    return null;
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendToNewAppsLog(newApps, discoveredAt) {
  const fileExists = fs.existsSync(NEW_APPS_LOG);
  const header = ['Discovered At', 'Name', 'App ID', 'Developer Name', 'Developer ID', 'Version', 'Source Repository', 'Published At', 'Community Topic ID'];

  const lines = [];
  if (!fileExists) lines.push(header.join(','));

  for (const app of newApps) {
    lines.push(
      [discoveredAt, app.name, app.appId, app.developerName, app.developerId, app.version, app.sourceRepository, app.publishedAt, app.communityTopicId || '']
        .map(csvEscape)
        .join(',')
    );
  }

  fs.appendFileSync(NEW_APPS_LOG, lines.join('\n') + '\n', 'utf8');
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('Fetching current app list from apps-api.athom.com ...');
  const rawApps = await fetchAllApps(); // full per-app detail objects -- the forum poster needs more than the simplified fields
  const currentApps = rawApps.map(simplify);
  console.log(`Retrieved details for ${currentApps.length} apps.`);

  const previousSnapshot = loadPreviousSnapshot();
  const runTimestamp = new Date().toISOString();
  let newRawApps = [];

  if (previousSnapshot === null) {
    console.log('No previous snapshot found -- this is the first run. Saving baseline.');
  } else {
    const previousIds = new Set(previousSnapshot.map((a) => a.appId));
    const newApps = currentApps.filter((a) => !previousIds.has(a.appId));

    if (newApps.length === 0) {
      console.log('No new apps since the last snapshot.');
    } else {
      console.log(`Found ${newApps.length} new app(s) since the last snapshot:`);

      // Small volume (just this run's new apps) -- worth the extra
      // homey.app page fetch to fill in a community topic ID when the
      // API itself didn't expose one directly.
      for (const app of newApps) {
        if (!app.communityTopicId) {
          app.communityTopicId = await communityTopicIdFromAppPage(app.appId);
        }
        console.log(`  - ${app.name} (${app.appId}) by ${app.developerName}${app.communityTopicId ? ` [topic ${app.communityTopicId}]` : ''}`);
      }
      appendToNewAppsLog(newApps, runTimestamp);

      const topicIdByAppId = new Map(newApps.map((a) => [a.appId, a.communityTopicId]));
      const newIds = new Set(newApps.map((a) => a.appId));
      newRawApps = rawApps
        .filter((a) => newIds.has(a.id))
        .map((a) => ({ ...a, communityTopicId: topicIdByAppId.get(a.id) || null }));
    }

    const currentIds = new Set(currentApps.map((a) => a.appId));
    const removedApps = previousSnapshot.filter((a) => !currentIds.has(a.appId));
    if (removedApps.length > 0) {
      console.log(`Note: ${removedApps.length} app(s) no longer listed (removed/delisted).`);
    }
  }

  // Full raw app objects for whatever's new THIS run -- consumed by
  // scripts/post-new-apps-to-forum.js. Overwritten every run (empty
  // array if nothing new), so it never grows unbounded.
  fs.writeFileSync(path.join(DATA_DIR, 'new-apps-this-run.json'), JSON.stringify(newRawApps, null, 2), 'utf8');

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentApps, null, 2), 'utf8');
  console.log(`Snapshot saved (${currentApps.length} apps).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});