/**
 * Attempts to find an app's Homey Community forum topic ID.
 *
 * The Athom Apps API's public schema doesn't document a field for this,
 * but the app manifest format supports "homeyCommunityTopicId", and when
 * set, the app's public homey.app page renders a "Community Forum" link
 * to https://community.homey.app/t/<topicId>. So:
 *   1. Check a few plausible field locations on the raw API app object
 *      (in case the API passes the manifest field through under some key).
 *   2. Fall back to fetching the public app page and scraping that link.
 *
 * Returns the numeric topic ID, or null if none is found.
 */

function fromApiObject(app) {
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

async function fromAppPage(appId) {
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

async function getCommunityTopicId(app) {
  const fromApi = fromApiObject(app);
  if (fromApi !== null) return fromApi;
  return fromAppPage(app.id);
}

module.exports = { getCommunityTopicId };
