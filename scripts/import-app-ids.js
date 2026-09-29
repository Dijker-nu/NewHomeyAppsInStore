/**
 * Imports specific app IDs that don't show up in the normal live
 * /app/ids listing -- private/unlisted apps, or apps that only have a
 * Test build -- into the "Unlisted Apps" tracking file
 * (data/homey-removed-apps.json).
 *
 * Reads one app ID per line from data/import-app-ids.txt (blank lines
 * and lines starting with # are ignored).
 *
 * Detection logic, in order of preference:
 *   1. GET /app/{appId}/changelog. Each version entry carries its own
 *      "state" (confirmed values include "live", "superseded", and
 *      "test"). If ANY version has ever been "live" or "superseded",
 *      the app has a genuine publish history -> Public (already
 *      tracked by discover-new-apps.js / update-apps.js, so skipped
 *      here) or Private (live, but not in the public /app/ids list --
 *      e.g. com.tuya) depending on current /app/ids membership. If
 *      EVERY version is "test" (or the changelog is otherwise all
 *      non-live), the app has never gone live -> Test.
 *      This is more reliable than just checking /app/{appId}'s
 *      liveVersion field, because the homey.app *page* for an app
 *      that's never been live can still display a Version/Updated
 *      block for its pending test build -- confirmed by comparing
 *      com.djordie.grokconnect (genuinely test-only, developer-
 *      confirmed) against eu.elro.homeeasy (has a real live version,
 *      just also had a test build pending) -- their /test pages look
 *      almost identical, so the page alone can't tell them apart.
 *   2. If the changelog call fails (empty/unreachable), falls back to
 *      /app/{appId}'s liveVersion field as a secondary signal.
 *   3. If both API calls fail outright, falls back to checking
 *      https://homey.app/a/{appId}/test directly (confirmed working
 *      link pattern). If that page loads, recorded as Test with only
 *      the bare ID -- a plain page fetch can't recover a structured
 *      name/developer.
 *   4. If nothing finds the app at all, it's reported as not found and
 *      skipped entirely.
 *
 * Run with:
 *   node scripts/import-app-ids.js
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://apps-api.athom.com/api/v1';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const IMPORT_FILE = path.join(DATA_DIR, 'import-app-ids.txt');
const REMOVED_FILE = path.join(DATA_DIR, 'homey-removed-apps.json');
const CONCURRENCY = 6;

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`Warning: could not read/parse ${file} (${err.message}).`);
    return fallback;
  }
}

function loadImportIds() {
  if (!fs.existsSync(IMPORT_FILE)) {
    console.log(`No ${path.relative(process.cwd(), IMPORT_FILE)} found. Create it with one app ID per line (lines starting with # are ignored).`);
    return [];
  }
  return fs
    .readFileSync(IMPORT_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
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

async function testPageExists(appId) {
  try {
    const res = await fetch(`https://homey.app/a/${encodeURIComponent(appId)}/test`);
    return res.ok;
  } catch {
    return false;
  }
}

// The changelog endpoint returns an object keyed by version string, each
// with its own "state" (confirmed values: "live", "superseded", "test").
async function fetchChangelog(appId) {
  try {
    const res = await fetch(`${BASE_URL}/app/${encodeURIComponent(appId)}/changelog`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

// true/false when the changelog gives a clear answer, null when it
// doesn't (empty, unreachable) so callers know to fall back elsewhere.
function hasEverBeenLive(changelog) {
  if (!changelog) return null;
  const states = Object.values(changelog)
    .map((v) => v && v.state)
    .filter(Boolean);
  if (states.length === 0) return null;
  return states.some((s) => s === 'live' || s === 'superseded');
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

async function classify(appId, liveIdSet) {
  const [result, changelog] = await Promise.all([fetchAppDetail(appId), fetchChangelog(appId)]);
  const everLive = hasEverBeenLive(changelog);

  if (result.ok) {
    const app = result.data;
    const build = app.liveBuild || {};
    const author = app.author || {};
    const base = {
      appId,
      name: (build.name && (build.name.en || Object.values(build.name)[0])) || appId,
      developerName: author.name || '',
      developerId: author.id || '',
      version: app.liveVersion || '',
      sourceRepository: build.source || '',
      communityTopicId: communityTopicIdFromApiObject(app),
      publishedAt: app.stateChangedAt || '',
    };

    // Prefer the changelog's per-version state when it gives a clear
    // answer; only fall back to the liveVersion field when it doesn't.
    const isLive = everLive !== null ? everLive : !!app.liveVersion;

    if (isLive) {
      const type = liveIdSet.has(appId) ? 'public' : 'private';
      return { ...base, type, found: true };
    }
    // Never been live -- test-only.
    return { ...base, type: 'test', found: true };
  }

  // Detail call failed. If the changelog nonetheless gave a clear "never
  // live" answer, that's enough on its own.
  if (everLive === false) {
    return {
      appId,
      name: appId,
      developerName: '',
      developerId: '',
      version: '',
      sourceRepository: '',
      communityTopicId: null,
      publishedAt: '',
      type: 'test',
      found: true,
    };
  }

  // Last resort, check the test page directly.
  const hasTestPage = await testPageExists(appId);
  if (hasTestPage) {
    return {
      appId,
      name: appId,
      developerName: '',
      developerId: '',
      version: '',
      sourceRepository: '',
      communityTopicId: null,
      publishedAt: '',
      type: 'test',
      found: true,
    };
  }

  return { appId, found: false };
}

async function main() {
  const ids = loadImportIds();
  if (ids.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  console.log(`Checking ${ids.length} app ID(s) from ${path.relative(process.cwd(), IMPORT_FILE)}...`);

  const liveIds = new Set(await fetchAppIds());
  const removedList = loadJson(REMOVED_FILE, []);
  const removedById = new Map(removedList.map((r) => [r.appId, r]));

  const results = await mapConcurrent(ids, (id) => classify(id, liveIds), CONCURRENCY);

  const now = new Date().toISOString();
  let imported = 0;
  let notFound = 0;
  let alreadyPublic = 0;

  for (const result of results) {
    if (!result.found) {
      notFound++;
      console.warn(`  Not found: ${result.appId}`);
      continue;
    }

    if (result.type === 'public') {
      alreadyPublic++;
      console.log(`  ${result.appId} is already publicly listed -- discover-new-apps.js / update-apps.js already track this one, skipping.`);
      continue;
    }

    const existing = removedById.get(result.appId);
    const entry = {
      appId: result.appId,
      name: result.name,
      developerName: result.developerName,
      developerId: result.developerId,
      version: result.version,
      sourceRepository: result.sourceRepository,
      communityTopicId: result.communityTopicId,
      publishedAt: result.publishedAt || (existing && existing.publishedAt) || '',
      removedAt: (existing && existing.removedAt) || now,
      lastCheckedAt: now,
      type: result.type, // 'private' | 'test'
      private: result.type === 'private', // kept for backward compatibility with older data
    };

    removedById.set(result.appId, entry);
    imported++;
    console.log(`  ${result.type === 'private' ? 'Private' : 'Test'}: ${entry.name} (${entry.appId})`);
  }

  const updatedList = Array.from(removedById.values());
  fs.writeFileSync(REMOVED_FILE, JSON.stringify(updatedList, null, 2), 'utf8');

  console.log(`Done. Imported/updated ${imported} app(s). ${alreadyPublic} already public. ${notFound} not found.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
