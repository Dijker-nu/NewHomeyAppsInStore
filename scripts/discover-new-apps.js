/**
 * Lightweight, frequent job (intended to run every 4 hours): detects
 * apps that are newly live (or came back after being retired) and
 * adds them to the snapshot. Does NOT rescan already-known apps for
 * changes, and does NOT handle removals -- that's scripts/update-apps.js,
 * intended to run once a day, since a full rescan is much more
 * expensive (one request per already-known app).
 *
 * Data files (relative to the repo root, or $DATA_DIR if set):
 *   data/homey-apps-snapshot.json   -- apps currently live, sorted old -> new
 *                                       by publishedAt. Each entry has both
 *                                       publishedAt (first time we ever saw
 *                                       it) and updatedAt (last time any of
 *                                       name/developer/version/topic ID
 *                                       actually changed -- only touched by
 *                                       update-apps.js after the initial add).
 *   data/homey-removed-apps.json    -- retired apps, minimal fields only
 *                                       (same shape as the snapshot, plus
 *                                       removedAt/lastCheckedAt/private).
 *   data/homey-new-apps-log.json    -- rolling log of discoveries, pruned
 *                                       to the last 30 days on every write.
 *   data/new-apps-this-run.json     -- just this run's discoveries (raw API
 *                                       detail), consumed by
 *                                       scripts/post-new-apps-to-forum.js.
 *
 * Run with:
 *   node scripts/discover-new-apps.js
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://apps-api.athom.com/api/v1';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'homey-apps-snapshot.json');
const REMOVED_FILE = path.join(DATA_DIR, 'homey-removed-apps.json');
const NEW_APPS_LOG_FILE = path.join(DATA_DIR, 'homey-new-apps-log.json');
const DETAIL_CONCURRENCY = 8;
const NEW_APPS_RETENTION_DAYS = 30;

async function fetchAppIds() {
  const res = await fetch(`${BASE_URL}/app/ids`);
  if (!res.ok) throw new Error(`Failed to fetch app IDs: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchAppDetail(id) {
  try {
    const res = await fetch(`${BASE_URL}/app/${encodeURIComponent(id)}`);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function mapConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
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
  const foundAt = app.stateChangedAt || new Date().toISOString();
  return {
    appId: app.id || '',
    name: (build.name && (build.name.en || Object.values(build.name)[0])) || '',
    developerName: author.name || '',
    developerId: author.id || '',
    version: app.liveVersion || '',
    sourceRepository: build.source || '',
    // First time we ever saw this app. Never touched again after creation.
    publishedAt: foundAt,
    // Last time anything about it actually changed. Starts equal to
    // publishedAt; only scripts/update-apps.js moves this forward.
    updatedAt: foundAt,
    communityTopicId: communityTopicIdFromApiObject(app),
  };
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`Warning: could not read/parse ${file} (${err.message}). Using fallback.`);
    return fallback;
  }
}

// Appends this run's discoveries to the rolling log, then prunes
// anything older than NEW_APPS_RETENTION_DAYS. Log entries mirror the
// snapshot's field shape plus a discoveredAt timestamp.
function appendAndPruneNewAppsLog(newEntries) {
  const existing = loadJson(NEW_APPS_LOG_FILE, []);
  const cutoff = Date.now() - NEW_APPS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const combined = [...existing, ...newEntries];
  const pruned = combined.filter((e) => e.discoveredAt && new Date(e.discoveredAt).getTime() >= cutoff);

  fs.writeFileSync(NEW_APPS_LOG_FILE, JSON.stringify(pruned, null, 2), 'utf8');

  const removedCount = combined.length - pruned.length;
  if (removedCount > 0) {
    console.log(`Pruned ${removedCount} entr${removedCount === 1 ? 'y' : 'ies'} older than ${NEW_APPS_RETENTION_DAYS} days from the new-apps log.`);
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('Fetching current live app IDs...');
  const liveIds = await fetchAppIds();
  console.log(`Found ${liveIds.length} live app IDs.`);

  const snapshot = loadJson(SNAPSHOT_FILE, []);
  const removedList = loadJson(REMOVED_FILE, []);

  const snapshotIds = new Set(snapshot.map((a) => a.appId));
  const removedIds = new Set(removedList.map((r) => r.appId));

  const brandNewIds = liveIds.filter((id) => !snapshotIds.has(id) && !removedIds.has(id));
  const rediscoveredIds = liveIds.filter((id) => removedIds.has(id));
  const toDiscover = [...brandNewIds, ...rediscoveredIds];

  if (toDiscover.length === 0) {
    console.log('No new or re-discovered apps this run.');
    return;
  }

  console.log(`${brandNewIds.length} brand-new app(s), ${rediscoveredIds.length} re-discovered app(s). Fetching details...`);

  const fetched = await mapConcurrent(
    toDiscover,
    async (id) => {
      const result = await fetchAppDetail(id);
      if (!result.ok) {
        console.warn(`  Warning: failed to fetch details for "${id}". Skipping it this run.`);
        return null;
      }
      return result.data;
    },
    DETAIL_CONCURRENCY
  );

  const discoveredAt = new Date().toISOString();
  const newLogEntries = [];
  const newRawApps = [];

  for (const raw of fetched.filter(Boolean)) {
    const simplified = simplify(raw);
    if (!simplified.communityTopicId) {
      simplified.communityTopicId = await communityTopicIdFromAppPage(simplified.appId);
    }
    snapshot.push(simplified);
    newLogEntries.push({ ...simplified, discoveredAt });
    newRawApps.push({ ...raw, communityTopicId: simplified.communityTopicId });
    console.log(`  - ${simplified.name} (${simplified.appId}) by ${simplified.developerName}${simplified.communityTopicId ? ` [topic ${simplified.communityTopicId}]` : ''}`);
  }

  // Apps that came back are no longer "removed".
  const rediscoveredSet = new Set(rediscoveredIds);
  for (let i = removedList.length - 1; i >= 0; i--) {
    if (rediscoveredSet.has(removedList[i].appId)) removedList.splice(i, 1);
  }

  snapshot.sort((a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0));

  appendAndPruneNewAppsLog(newLogEntries);
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.writeFileSync(REMOVED_FILE, JSON.stringify(removedList, null, 2), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'new-apps-this-run.json'), JSON.stringify(newRawApps, null, 2), 'utf8');

  console.log(`Done. Added ${newLogEntries.length} app(s). Snapshot now has ${snapshot.length} live apps.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
