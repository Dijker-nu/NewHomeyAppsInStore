/**
 * Incrementally maintains the Homey App Store snapshot:
 *
 *   - data/homey-apps-snapshot.json  -- apps currently (or newly)
 *     live, sorted old -> new by publishedAt. Existing entries are
 *     NOT refreshed on later runs -- only new/re-discovered apps are
 *     added, and an entry is removed the moment its app drops off the
 *     live /app/ids list (see homey-removed-apps.json below).
 *   - data/homey-removed-apps.json   -- apps that dropped off the live
 *     list, keeping the full last-known raw API detail. Re-checked
 *     each run against /app/{appId} directly (which can still work
 *     for apps gone private rather than fully deleted), so liveVersion
 *     and private stay current even after removal.
 *   - data/homey-new-apps-log.csv    -- running log of newly- or
 *     re-discovered apps, appended each run.
 *
 * IMPORTANT BEHAVIOR CHANGE from earlier versions of this script: it
 * used to re-fetch full detail for EVERY live app on EVERY run, so an
 * already-known app's version etc. stayed current. It no longer does
 * that -- an already-known, still-live app's snapshot entry is frozen
 * at whatever it looked like when first discovered. Only genuinely
 * new/re-discovered apps, and already-removed apps (for their
 * liveVersion/private re-check), trigger a fetch. This keeps routine
 * runs fast and cheap, but it does mean the Version column for
 * long-standing apps won't reflect later updates.
 *
 * publishedAt semantics:
 *   - For an app discovered as brand new (or re-discovered after being
 *     removed) by this script, publishedAt = that fetch's
 *     stateChangedAt -- for a genuinely new app that's effectively its
 *     first-publish date.
 *   - Apps already in the snapshot before this script started tracking
 *     them won't have an accurate first-publish date from this script
 *     alone -- see scripts/backfill-published-dates.js for a one-time
 *     correction via the /app/{appId}/changelog endpoint.
 *
 * NOTE ON A COLD START: if homey-apps-snapshot.json doesn't exist yet
 * (or is empty), EVERY currently-live app is treated as "brand new"
 * this run -- so the first run after adopting this script does the
 * same full-catalog fetch (detail + community-topic lookup) the old
 * version always did, once. After that, it should only be small deltas.
 *
 * Run with:
 *   node scripts/snapshot-homey-apps.js
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://apps-api.athom.com/api/v1';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'homey-apps-snapshot.json');
const REMOVED_FILE = path.join(DATA_DIR, 'homey-removed-apps.json');
const NEW_APPS_LOG = path.join(DATA_DIR, 'homey-new-apps-log.csv');
const DETAIL_CONCURRENCY = 8;

async function fetchAppIds() {
  const res = await fetch(`${BASE_URL}/app/ids`);
  if (!res.ok) {
    throw new Error(`Failed to fetch app IDs: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Note: this deliberately does NOT throw on a non-OK response -- a
// removed app is expected to sometimes 404 here (fully deleted) or
// still succeed (gone private but still individually fetchable), and
// callers need to distinguish "fetch failed" from "app not found" cleanly.
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
  return {
    appId: app.id || '',
    name: (build.name && (build.name.en || Object.values(build.name)[0])) || '',
    developerName: author.name || '',
    developerId: author.id || '',
    version: app.liveVersion || '',
    sourceRepository: build.source || '',
    publishedAt: app.stateChangedAt || '',
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

  console.log('Fetching current live app IDs...');
  const liveIds = await fetchAppIds();
  const liveIdSet = new Set(liveIds);
  console.log(`Found ${liveIds.length} live app IDs.`);

  const snapshot = loadJson(SNAPSHOT_FILE, []); // simplified objects, kept sorted old -> new
  const removedList = loadJson(REMOVED_FILE, []); // removed-app records with full raw detail

  const snapshotIds = new Set(snapshot.map((a) => a.appId));
  const removedIds = new Set(removedList.map((r) => r.appId));

  const brandNewIds = liveIds.filter((id) => !snapshotIds.has(id) && !removedIds.has(id));
  const rediscoveredIds = liveIds.filter((id) => removedIds.has(id));
  const goneIds = [...snapshotIds].filter((id) => !liveIdSet.has(id));

  const runTimestamp = new Date().toISOString();
  const loggedNewApps = [];
  const newRawApps = []; // consumed by scripts/post-new-apps-to-forum.js

  // --- Brand-new + re-discovered apps: fetch full detail, add to snapshot ---
  const toDiscover = [...brandNewIds, ...rediscoveredIds];
  if (toDiscover.length > 0) {
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

    for (const raw of fetched.filter(Boolean)) {
      const simplified = simplify(raw);
      if (!simplified.communityTopicId) {
        simplified.communityTopicId = await communityTopicIdFromAppPage(simplified.appId);
      }
      snapshot.push(simplified);
      loggedNewApps.push(simplified);
      newRawApps.push({ ...raw, communityTopicId: simplified.communityTopicId });
      console.log(`  - ${simplified.name} (${simplified.appId}) by ${simplified.developerName}${simplified.communityTopicId ? ` [topic ${simplified.communityTopicId}]` : ''}`);
    }

    // Apps that came back are no longer "removed".
    const rediscoveredSet = new Set(rediscoveredIds);
    for (let i = removedList.length - 1; i >= 0; i--) {
      if (rediscoveredSet.has(removedList[i].appId)) removedList.splice(i, 1);
    }
  } else {
    console.log('No new or re-discovered apps this run.');
  }

  if (loggedNewApps.length > 0) {
    appendToNewAppsLog(loggedNewApps, runTimestamp);
  }

  // --- Apps that disappeared from the live list this run: move to the removed-apps file ---
  if (goneIds.length > 0) {
    console.log(`${goneIds.length} app(s) dropped off the live list. Checking each individually and moving to the removed-apps file...`);

    const goneSet = new Set(goneIds);
    const goneEntries = snapshot.filter((a) => goneSet.has(a.appId));
    for (let i = snapshot.length - 1; i >= 0; i--) {
      if (goneSet.has(snapshot[i].appId)) snapshot.splice(i, 1);
    }

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
            removedAt: now,
            lastCheckedAt: now,
            liveVersion: raw.liveVersion || entry.version || '',
            private: typeof raw.private === 'boolean' ? raw.private : null,
            raw,
          };
        }
        return {
          appId: entry.appId,
          name: entry.name,
          developerName: entry.developerName,
          removedAt: now,
          lastCheckedAt: now,
          liveVersion: entry.version || '',
          private: null,
          raw: null, // not fetchable individually either -- likely fully deleted
        };
      },
      DETAIL_CONCURRENCY
    );

    removedList.push(...newlyRemoved);
    for (const r of newlyRemoved) {
      console.log(`  - removed: ${r.name} (${r.appId})${r.raw ? '' : ' (no longer fetchable individually)'}`);
    }
  }

  // --- Re-check apps that were ALREADY removed (and still are), so liveVersion/private stay current ---
  const justRemovedSet = new Set(goneIds);
  const stillRemoved = removedList.filter((r) => !liveIdSet.has(r.appId) && !justRemovedSet.has(r.appId));
  if (stillRemoved.length > 0) {
    console.log(`Re-checking ${stillRemoved.length} previously-removed app(s) for updates...`);

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
            liveVersion: raw.liveVersion || entry.liveVersion || '',
            private: typeof raw.private === 'boolean' ? raw.private : entry.private,
            raw,
          };
        }
        return { appId: entry.appId, lastCheckedAt: now };
      },
      DETAIL_CONCURRENCY
    );

    const updateById = new Map(updates.map((u) => [u.appId, u]));
    for (let i = 0; i < removedList.length; i++) {
      const u = updateById.get(removedList[i].appId);
      if (u) removedList[i] = { ...removedList[i], ...u };
    }
  }

  // Keep the snapshot sorted old -> new by publishedAt, always.
  snapshot.sort((a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0));

  fs.writeFileSync(path.join(DATA_DIR, 'new-apps-this-run.json'), JSON.stringify(newRawApps, null, 2), 'utf8');
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.writeFileSync(REMOVED_FILE, JSON.stringify(removedList, null, 2), 'utf8');

  console.log(`Done. Snapshot: ${snapshot.length} live apps. Removed: ${removedList.length} apps.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});