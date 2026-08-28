/**
 * For each app found new in this run (data/new-apps-this-run.json,
 * written by snapshot-homey-apps.js), post one reply to the Homey
 * Community forum topic:
 *   https://community.homey.app/t/list-new-published-app-in-homey-app-store-get-em-while-theyre-hot/100276
 *
 * Following that topic's stated rules:
 *   - Only apps for Homey Pro (skips apps whose "platforms" doesn't include "local", if that field is present).
 *   - One reply per app, in the order they were published (oldest first).
 *   - Uses the language-agnostic link: https://homey.app/a/<appId>
 *   - Adds the Community Topic link too, if the app publishes one (see lib/homey-community-topic.js).
 *   - Mentions @AppStore, since this poster is not the app's developer.
 *
 * SAFETY: posting is a DRY RUN by default -- it only logs what it would
 * post. To actually post, set POST_TO_FORUM=true AND provide
 * DISCOURSE_API_KEY / DISCOURSE_API_USERNAME for an account with
 * posting rights on community.homey.app. Review dry-run output for a
 * while before flipping this on; unattended forum bots can be viewed
 * as spam even when well-intentioned, so it's worth reading the
 * forum's rules and this topic's guideline yourself first, and
 * consider asking a moderator before enabling live posting.
 *
 * Run with:
 *   node scripts/post-new-apps-to-forum.js
 */

const fs = require('fs');
const path = require('path');
const { getCommunityTopicId } = require('./lib/homey-community-topic');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const NEW_APPS_FILE = path.join(DATA_DIR, 'new-apps-this-run.json');

const FORUM_TOPIC_ID = 100276; // "[LIST] NEW published App in Homey App store" topic
const DISCOURSE_BASE = 'https://community.homey.app';

const POST_TO_FORUM = process.env.POST_TO_FORUM === 'true';
const API_KEY = process.env.DISCOURSE_API_KEY;
const API_USERNAME = process.env.DISCOURSE_API_USERNAME;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHomeyProCompatible(app) {
  // Some app objects expose a "platforms" array (mirrors the app.json
  // manifest field: ["local"] = Homey Pro, ["cloud"] = Homey Cloud/Bridge
  // only, or both). If the field isn't present, don't filter -- err on
  // the side of including it rather than silently dropping real apps
  // because of an API shape assumption that turned out wrong.
  if (!Array.isArray(app.platforms)) return true;
  return app.platforms.includes('local');
}

function buildPostBody(app, communityTopicId) {
  const appUrl = `https://homey.app/a/${app.id}`;
  const lines = [];

  // Plain inline link (leading space keeps Discourse from oneboxing this one).
  lines.push(` ${appUrl}`);
  lines.push('');
  // Bare on its own line -- Discourse auto-oneboxes this into a rich card/frame.
  lines.push(appUrl);

  if (communityTopicId) {
    lines.push('');
    lines.push(` ${DISCOURSE_BASE}/t/${communityTopicId}`);
  }

  lines.push('');
  lines.push('@AppStore');

  return lines.join('\n');
}

async function postReply(raw) {
  const res = await fetch(`${DISCOURSE_BASE}/posts.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': API_KEY,
      'Api-Username': API_USERNAME,
    },
    body: JSON.stringify({ topic_id: FORUM_TOPIC_ID, raw }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discourse post failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

function loadNewApps() {
  if (!fs.existsSync(NEW_APPS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(NEW_APPS_FILE, 'utf8'));
  } catch (err) {
    console.warn(`Warning: could not read/parse ${NEW_APPS_FILE} (${err.message}).`);
    return [];
  }
}

async function main() {
  const newApps = loadNewApps();

  if (newApps.length === 0) {
    console.log('No new apps this run -- nothing to post.');
    return;
  }

  // Post in the order they were published, oldest first, per the topic's rules.
  newApps.sort((a, b) => new Date(a.stateChangedAt || 0) - new Date(b.stateChangedAt || 0));

  const eligible = newApps.filter(isHomeyProCompatible);
  const skipped = newApps.length - eligible.length;
  if (skipped > 0) {
    console.log(`Skipping ${skipped} app(s) that don't list Homey Pro ("local") as a supported platform.`);
  }

  if (!POST_TO_FORUM) {
    console.log('DRY RUN (POST_TO_FORUM is not "true") -- nothing will actually be posted. Showing what would be sent:\n');
  } else if (!API_KEY || !API_USERNAME) {
    console.error('POST_TO_FORUM is true but DISCOURSE_API_KEY / DISCOURSE_API_USERNAME are not set. Aborting.');
    process.exit(1);
  }

  for (const app of eligible) {
    const name = (app.liveBuild && app.liveBuild.name && (app.liveBuild.name.en || Object.values(app.liveBuild.name)[0])) || app.id;
    const communityTopicId = await getCommunityTopicId(app);
    const body = buildPostBody(app, communityTopicId);

    console.log('----------------------------------------');
    console.log(`App: ${name} (${app.id})`);
    if (communityTopicId) console.log(`Community topic found: ${DISCOURSE_BASE}/t/${communityTopicId}`);
    console.log('Post body:');
    console.log(body);

    if (POST_TO_FORUM) {
      try {
        const result = await postReply(body);
        console.log(`Posted: ${DISCOURSE_BASE}/t/${FORUM_TOPIC_ID}/${result.post_number || ''}`);
      } catch (err) {
        console.error(`Failed to post for ${app.id}: ${err.message}`);
      }
      // Be gentle with the forum's rate limits between multiple posts.
      await sleep(8000);
    }
  }

  console.log('----------------------------------------');
  console.log(`Done. ${eligible.length} app(s) processed${POST_TO_FORUM ? ' and posted' : ' (dry run only)'}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
