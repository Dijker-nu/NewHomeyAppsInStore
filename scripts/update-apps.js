/**
 * Heavier job (intended to run once a day): does a full rescan of
 * every already-known live app, refreshing its snapshot entry (name,
 * developer, version, community topic ID) and moving its updatedAt
 * forward ONLY when something actually changed. Also handles:
 *   - Apps that dropped off the live /app/ids list -> moved to
 *     data/homey-removed-apps.json.
 *   - Apps already in the removed list -> re-checked (liveVersion,
 *     private) in case they changed while retired.
 *   - As a safety net, any app that's neither in the snapshot nor the
 *     removed list is treated as newly discovered here too (in case a
 *     scripts/discover-new-apps.js run was missed) -- and logged the
 *     same way discover-new-apps.js would.
 *
 * This does one API request per already-known app (plus a community
 * topic ID check that's a free field read, not a network request), so
 * for a store with several hundred apps this is a real cost -- hence
 * running it daily rather than every 4 hours like discover-new-apps.js.
 * It deliberately does NOT do the homey.app page-scrape fallback for
 * community topic IDs on every app (only for genuinely new ones this
 * run), since scraping every app's page daily would multiply the cost
 * again for a field that rarely changes.
 *
 * Run with:
 *   node scripts/update-apps.js
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
    publishedAt: foundAt,
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

function appendAndPruneNewAppsLog(newEntries) {
  if (newEntries.length === 0) return;
  const existing = loadJson(NEW_APPS_LOG_FILE, []);
  const cutoff = Date.now() - NEW_APPS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const combined = [...existing, ...newEntries];
  const pruned = combined.filter((e) => e.discoveredAt && new Date(e.discoveredAt).getTime() >= cutoff);
  fs.writeFileSync(NEW_APPS_LOG_FILE, JSON.stringify(pruned, null, 2), 'utf8');
}

// Which of the tracked fields differ between the stored entry and a
// freshly-fetched one? Returns the updated entry (untouched if nothing changed).
function mergeIfChanged(existing, fresh) {
  const fields = ['name', 'developerName', 'developerId', 'version', 'sourceRepository', 'communityTopicId'];
  let changed = false;
  const next = { ...existing };
  for (const f of fields) {
    if (fresh[f] !== existing[f] && fresh[f] !== null && fresh[f] !== '') {
      next[f] = fresh[f];
      changed = true;
    }
  }
  if (changed) next.updatedAt = new Date().toISOString();
  return { entry: next, changed };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('Fetching current live app IDs...');
  const liveIds = await fetchAppIds();
  const liveIdSet = new Set(liveIds);
  console.log(`Found ${liveIds.length} live app IDs.`);

  let snapshot = loadJson(SNAPSHOT_FILE, []);
  let removedList = loadJson(REMOVED_FILE, []);

  const snapshotIds = new Set(snapshot.map((a) => a.appId));
  const removedIds = new Set(removedList.map((r) => r.appId));

  // --- Safety net: anything neither known nor removed is treated as new ---
  const brandNewIds = liveIds.filter((id) => !snapshotIds.has(id) && !removedIds.has(id));
  const newLogEntries = [];
  const newRawApps = [];

  if (brandNewIds.length > 0) {
    console.log(`${brandNewIds.length} app(s) were neither tracked nor removed (safety net -- discover-new-apps.js may have missed them). Fetching details...`);
    const fetched = await mapConcurrent(
      brandNewIds,
      async (id) => {
        const result = await fetchAppDetail(id);
        if (!result.ok) return null;
        return result.data;
      },
      DETAIL_CONCURRENCY
    );

    const discoveredAt = new Date().toISOString();
    for (const raw of fetched.filter(Boolean)) {
      const simplified = simplify(raw);
      if (!simplified.communityTopicId) {
        simplified.communityTopicId = await communityTopicIdFromAppPage(simplified.appId);
      }
      snapshot.push(simplified);
      newLogEntries.push({ ...simplified, discoveredAt });
      newRawApps.push({ ...raw, communityTopicId: simplified.communityTopicId });
    }
  }

  // --- Full rescan of already-known, still-live apps ---
  const rescanTargets = snapshot.filter((a) => liveIdSet.has(a.appId) && !brandNewIds.includes(a.appId));
  console.log(`Rescanning ${rescanTargets.length} already-known live app(s) for changes...`);

  let changedCount = 0;
  const rescanResults = await mapConcurrent(
    rescanTargets,
    async (entry) => {
      const result = await fetchAppDetail(entry.appId);
      if (!result.ok) return { appId: entry.appId, ok: false };
      const fresh = simplify(result.data);
      return { appId: entry.appId, ok: true, fresh };
    },
    DETAIL_CONCURRENCY
  );

  const resultByAppId = new Map(rescanResults.map((r) => [r.appId, r]));
  snapshot = snapshot.map((entry) => {
    const result = resultByAppId.get(entry.appId);
    if (!result) return entry; // wasn't a rescan target (e.g. brand-new this run)
    if (!result.ok) {
      console.warn(`  Warning: failed to re-fetch "${entry.appId}" during rescan. Leaving it unchanged.`);
      return entry;
    }
    const { entry: merged, changed } = mergeIfChanged(entry, result.fresh);
    if (changed) {
      changedCount++;
      console.log(`  - updated: ${merged.name} (${merged.appId})`);
    }
    return merged;
  });
  console.log(`${changedCount} app(s) had a change detected (name/developer/version/topic ID).`);

  // --- Apps that dropped off the live list: move to removed-apps.json ---
  const goneIds = snapshot.filter((a) => !liveIdSet.has(a.appId)).map((a) => a.appId);
  if (goneIds.length > 0) {
    console.log(`${goneIds.length} app(s) dropped off the live list. Moving to the removed-apps file...`);
    const goneSet = new Set(goneIds);
    const goneEntries = snapshot.filter((a) => goneSet.has(a.appId));
    snapshot = snapshot.filter((a) => !goneSet.has(a.appId));

    const newlyRemoved = await mapConcurrent(
      goneEntries,
      async (entry) => {
        const result = await fetchAppDetail(entry.appId);
        const now = new Date().toISOString();
        if (result.ok) {
          const raw = result.data;
          return {
            appId: entry.appId,
            name: entry.name,
            developerName: entry.developerName,
            developerId: entry.developerId,
            version: raw.liveVersion || entry.version || '',
            sourceRepository: entry.sourceRepository,
            communityTopicId: entry.communityTopicId,
            publishedAt: entry.publishedAt,
            removedAt: now,
            lastCheckedAt: now,
            private: typeof raw.private === 'boolean' ? raw.private : null,
          };
        }
        return {
          appId: entry.appId,
          name: entry.name,
          developerName: entry.developerName,
          developerId: entry.developerId,
          version: entry.version,
          sourceRepository: entry.sourceRepository,
          communityTopicId: entry.communityTopicId,
          publishedAt: entry.publishedAt,
          removedAt: now,
          lastCheckedAt: now,
          private: null,
        };
      },
      DETAIL_CONCURRENCY
    );

    removedList.push(...newlyRemoved);
    for (const r of newlyRemoved) console.log(`  - removed: ${r.name} (${r.appId})`);
  }

  // --- Re-check apps that were already removed (and still are) ---
  const justRemovedSet = new Set(goneIds);
  const stillRemoved = removedList.filter((r) => !liveIdSet.has(r.appId) && !justRemovedSet.has(r.appId));
  if (stillRemoved.length > 0) {
    console.log(`Re-checking ${stillRemoved.length} previously-removed app(s)...`);
    const updates = await mapConcurrent(
      stillRemoved,
      async (entry) => {
        const result = await fetchAppDetail(entry.appId);
        const now = new Date().toISOString();
        if (result.ok) {
          const raw = result.data;
          return {
            appId: entry.appId,
            lastCheckedAt: now,
            version: raw.liveVersion || entry.version || '',
            private: typeof raw.private === 'boolean' ? raw.private : entry.private,
          };
        }
        return { appId: entry.appId, lastCheckedAt: now };
      },
      DETAIL_CONCURRENCY
    );
    const updateById = new Map(updates.map((u) => [u.appId, u]));
    removedList = removedList.map((r) => {
      const u = updateById.get(r.appId);
      return u ? { ...r, ...u } : r;
    });
  }

  snapshot.sort((a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0));

  appendAndPruneNewAppsLog(newLogEntries);
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.writeFileSync(REMOVED_FILE, JSON.stringify(removedList, null, 2), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'new-apps-this-run.json'), JSON.stringify(newRawApps, null, 2), 'utf8');

  console.log(`Done. Snapshot: ${snapshot.length} live apps (${changedCount} updated). Removed: ${removedList.length} apps.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
