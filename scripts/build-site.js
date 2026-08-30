/**
 * Prepares the static site in public/:
 *   - Converts data/homey-new-apps-log.csv to public/data/new-apps-log.json
 *   - Copies data/homey-apps-snapshot.json to public/data/homey-apps-snapshot.json
 *   - Converts data/homey-removed-apps.json (full raw detail) to a
 *     lighter public/data/removed-apps.json (summary fields only --
 *     the full raw blobs stay in the repo's data/ folder, not published)
 *   - Writes public/index.html, a static shell that fetches all three
 *     JSON files client-side and renders everything in the browser.
 *
 * Run with:
 *   node scripts/build-site.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');
const PUBLIC_DATA_DIR = path.join(PUBLIC_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'homey-new-apps-log.csv');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'homey-apps-snapshot.json');
const REMOVED_FILE = path.join(DATA_DIR, 'homey-removed-apps.json');

// Minimal RFC4180-ish CSV parser (handles quoted fields with commas/quotes).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

function loadNewAppsLogAsJson() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const rows = parseCsv(fs.readFileSync(LOG_FILE, 'utf8'));
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((r) => {
    const obj = {};
    header.forEach((h, i) => (obj[h] = r[i] || ''));
    return obj;
  });
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function loadRemovedAppsForPublic() {
  if (!fs.existsSync(REMOVED_FILE)) return [];
  let list;
  try {
    list = JSON.parse(fs.readFileSync(REMOVED_FILE, 'utf8'));
  } catch {
    return [];
  }
  // Publish a lighter summary -- the full raw API blob per app stays in
  // the repo's data/ folder only, so the public site doesn't ship it.
  return list.map((r) => {
    const build = (r.raw && r.raw.liveBuild) || {};
    const author = (r.raw && r.raw.author) || {};
    return {
      appId: r.appId,
      name: r.name || (build.name && (build.name.en || Object.values(build.name)[0])) || r.appId,
      developerName: r.developerName || author.name || '',
      version: r.liveVersion || '',
      sourceRepository: build.source || '',
      removedAt: r.removedAt || '',
      lastCheckedAt: r.lastCheckedAt || '',
      private: typeof r.private === 'boolean' ? r.private : null,
    };
  });
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>New Homey Apps</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 1080px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin-bottom: 0.25rem; }
  .subtitle { color: #666; margin-top: 0; margin-bottom: 1.5rem; }
  .controls { margin-bottom: 1rem; }
  input#search { width: 100%; padding: 0.6rem 0.8rem; font-size: 1rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; margin-bottom: 0.8rem; }
  .tabs { display: flex; gap: 0.4rem; border-bottom: 1px solid #ddd; }
  .tab-btn { padding: 0.55rem 1rem; font-size: 0.92rem; border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; background: none; color: inherit; cursor: pointer; opacity: 0.65; }
  .tab-btn:hover { opacity: 1; }
  .tab-btn.active { opacity: 1; border-color: #ddd; background: Canvas; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; display: none; margin-top: 1rem; }
  table.active { display: table; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.92rem; vertical-align: middle; }
  th { position: sticky; top: 0; background: Canvas; }
  tr:hover { background: rgba(127,127,127,0.08); }
  .muted { color: #888; font-size: 0.85em; }
  footer { margin-top: 2rem; color: #888; font-size: 0.85em; }
  a { color: #2b6cb0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { display: none; padding: 2rem 0; color: #888; text-align: center; }
  .caption { display: none; color: #888; font-size: 0.85em; margin: 0.6rem 0 0; }
  .load-more-wrap { display: none; text-align: center; margin-top: 1rem; }
  .load-more-btn { padding: 0.5rem 1.2rem; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 6px; background: Canvas; color: CanvasText; cursor: pointer; }
  .load-more-btn:hover { background: rgba(127,127,127,0.12); }
  .copy-btn { padding: 0.3rem 0.7rem; font-size: 0.82rem; border: 1px solid #ccc; border-radius: 5px; background: Canvas; color: CanvasText; cursor: pointer; }
  .copy-btn:hover { background: rgba(127,127,127,0.12); }
  .copy-btn:disabled { opacity: 0.7; cursor: default; }
  .badge { font-size: 0.78em; padding: 0.1rem 0.45rem; border-radius: 4px; background: rgba(127,127,127,0.18); }
</style>
</head>
<body>
  <h1>New Homey Apps</h1>
  <p class="subtitle" id="subtitle">Loading data...</p>

  <div class="controls">
    <input id="search" type="search" placeholder="Filter by app name or developer..." autocomplete="off">
    <div class="tabs">
      <button class="tab-btn" type="button" data-tab="all">All Apps</button>
      <button class="tab-btn active" type="button" data-tab="new">New Apps</button>
      <button class="tab-btn" type="button" data-tab="retired">Retired Apps</button>
    </div>
  </div>

  <table id="tab-all" data-tab="all">
    <thead><tr><th>Published/Updated</th><th>Name</th><th>App ID</th><th>Developer</th><th>Version</th><th>Source</th><th>Forum post</th></tr></thead>
    <tbody></tbody>
  </table>

  <table id="tab-new" class="active" data-tab="new">
    <thead><tr><th>Discovered</th><th>Name</th><th>App ID</th><th>Developer</th><th>Version</th><th>Source</th><th>Forum post</th></tr></thead>
    <tbody></tbody>
  </table>

  <table id="tab-retired" data-tab="retired">
    <thead><tr><th>Removed</th><th>Name</th><th>App ID</th><th>Developer</th><th>Last Version</th><th>Private</th><th>Source</th></tr></thead>
    <tbody></tbody>
  </table>

  <p class="empty" id="all-empty"></p>
  <p class="empty" id="new-empty"></p>
  <p class="empty" id="retired-empty"></p>

  <p class="caption" id="all-caption"></p>
  <p class="caption" id="new-caption"></p>
  <p class="caption" id="retired-caption"></p>

  <div class="load-more-wrap" id="load-more-wrap">
    <button class="load-more-btn" id="load-more-btn" type="button">Load more</button>
  </div>

  <footer>Data sourced from Athom's app-store API (apps-api.athom.com), sampled once per day. "All Apps" is sorted newest-published first; "Retired Apps" shows apps that dropped off the live store listing, re-checked periodically for version/visibility changes. The "Forum post" copy button builds the text suggested by <a href="https://community.homey.app/t/list-new-published-app-in-homey-app-store-get-em-while-theyre-hot/100276" target="_blank" rel="noopener">this Homey Community topic's guideline</a> -- review it before posting.</footer>

  <script>
    const PAGE_SIZE = 20;

    const state = {
      activeTab: 'new',
      visibleCount: { all: PAGE_SIZE, new: PAGE_SIZE, retired: PAGE_SIZE },
      data: { all: [], new: [], retired: [] },
    };

    const input = document.getElementById('search');
    const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
    const tables = {
      all: document.getElementById('tab-all'),
      new: document.getElementById('tab-new'),
      retired: document.getElementById('tab-retired'),
    };
    const emptyEls = {
      all: document.getElementById('all-empty'),
      new: document.getElementById('new-empty'),
      retired: document.getElementById('retired-empty'),
    };
    const captionEls = {
      all: document.getElementById('all-caption'),
      new: document.getElementById('new-caption'),
      retired: document.getElementById('retired-caption'),
    };
    const loadMoreWrap = document.getElementById('load-more-wrap');
    const loadMoreBtn = document.getElementById('load-more-btn');
    const subtitle = document.getElementById('subtitle');

    function escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Builds the forum reply text per community.homey.app/t/.../100276's
    // guideline: a plain link (leading space keeps it un-oneboxed), a
    // blank bare link (Discourse auto-oneboxes it into a rich card), and
    // an optional community-topic link, all followed by an @AppStore mention.
    function buildForumPost(app) {
      const appUrl = 'https://homey.app/a/' + app.appId;
      const lines = [' ' + appUrl, '', appUrl];
      if (app.communityTopicId) {
        lines.push('', ' https://community.homey.app/t/' + app.communityTopicId);
      }
      lines.push('', '@AppStore');
      return lines.join('\\n');
    }

    function copyToClipboard(text, button) {
      const original = button.textContent;
      navigator.clipboard.writeText(text).then(() => {
        button.textContent = 'Copied!';
        button.disabled = true;
        setTimeout(() => { button.textContent = original; button.disabled = false; }, 1500);
      }).catch(() => {
        window.prompt('Copy this text:', text);
      });
    }

    function sourceCellHtml(sourceRepository) {
      return sourceRepository
        ? '<a href="' + escapeHtml(sourceRepository) + '" target="_blank" rel="noopener">source</a>'
        : '<span class="muted">—</span>';
    }

    function renderRow(app, dateValue, opts) {
      opts = opts || {};
      const storeUrl = 'https://homey.app/a/' + encodeURIComponent(app.appId);
      const tr = document.createElement('tr');

      let extraCell;
      if (opts.retired) {
        extraCell = '<td>' + (app.private === true ? '<span class="badge">private</span>' : app.private === false ? '<span class="badge">public</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td>' + sourceCellHtml(app.sourceRepository) + '</td>';
      } else {
        extraCell = '<td>' + sourceCellHtml(app.sourceRepository) + '</td>' +
          '<td><button class="copy-btn" type="button">Copy</button></td>';
      }

      tr.innerHTML =
        '<td>' + escapeHtml(dateValue ? String(dateValue).slice(0, 10) : '') + '</td>' +
        '<td><a href="' + storeUrl + '" target="_blank" rel="noopener">' + escapeHtml(app.name) + '</a></td>' +
        '<td class="muted">' + escapeHtml(app.appId) + '</td>' +
        '<td>' + escapeHtml(app.developerName) + '</td>' +
        '<td>' + escapeHtml(app.version) + '</td>' +
        extraCell;

      if (!opts.retired) {
        tr.querySelector('.copy-btn').addEventListener('click', (ev) => {
          copyToClipboard(buildForumPost(app), ev.currentTarget);
        });
      }

      return tr;
    }

    function currentQuery() {
      return input.value.trim().toLowerCase();
    }

    function matches(app, q) {
      return ((app.name || '') + ' ' + (app.developerName || '')).toLowerCase().includes(q);
    }

    function getSortedFiltered(tab, q) {
      const filtered = state.data[tab].filter((a) => matches(a, q));
      if (tab === 'new') {
        filtered.sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt));
      } else if (tab === 'retired') {
        filtered.sort((a, b) => new Date(b.removedAt) - new Date(a.removedAt));
      } else {
        filtered.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      }
      return filtered;
    }

    function renderTab(tab) {
      const table = tables[tab];
      const tbody = table.querySelector('tbody');
      tbody.innerHTML = '';

      const q = currentQuery();
      const filtered = getSortedFiltered(tab, q);
      const shown = filtered.slice(0, state.visibleCount[tab]);

      for (const app of shown) {
        const dateValue = tab === 'new' ? app.discoveredAt : tab === 'retired' ? app.removedAt : app.publishedAt;
        tbody.appendChild(renderRow(app, dateValue, { retired: tab === 'retired' }));
      }

      const emptyEl = emptyEls[tab];
      const captionEl = captionEls[tab];

      if (state.data[tab].length === 0) {
        emptyEl.textContent = tab === 'new'
          ? 'No new apps detected yet. Check back after the next scheduled run.'
          : tab === 'retired'
            ? 'No retired apps detected yet.'
            : 'No data yet. Check back after the next scheduled run.';
        emptyEl.style.display = '';
        captionEl.style.display = 'none';
      } else if (shown.length === 0) {
        emptyEl.textContent = 'No matches for that search.';
        emptyEl.style.display = '';
        captionEl.style.display = 'none';
      } else {
        emptyEl.style.display = 'none';
        captionEl.style.display = '';
        captionEl.textContent = 'Showing ' + shown.length + ' of ' + filtered.length + ' matching app(s).';
      }

      loadMoreWrap.style.display = filtered.length > shown.length ? '' : 'none';
    }

    function switchTab(tab) {
      state.activeTab = tab;
      for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === tab);
      for (const key of Object.keys(tables)) tables[key].classList.toggle('active', key === tab);
      for (const key of Object.keys(captionEls)) if (key !== tab) captionEls[key].style.display = 'none';
      for (const key of Object.keys(emptyEls)) if (key !== tab) emptyEls[key].style.display = 'none';
      renderTab(tab);
    }

    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    input.addEventListener('input', () => {
      state.visibleCount = { all: PAGE_SIZE, new: PAGE_SIZE, retired: PAGE_SIZE };
      renderTab(state.activeTab);
    });

    loadMoreBtn.addEventListener('click', () => {
      state.visibleCount[state.activeTab] += PAGE_SIZE;
      renderTab(state.activeTab);
    });

    async function init() {
      let newLog = [];
      let snapshot = [];
      let removed = [];
      try {
        const [newRes, snapRes, removedRes] = await Promise.all([
          fetch('./data/new-apps-log.json'),
          fetch('./data/homey-apps-snapshot.json'),
          fetch('./data/removed-apps.json'),
        ]);
        newLog = newRes.ok ? await newRes.json() : [];
        snapshot = snapRes.ok ? await snapRes.json() : [];
        removed = removedRes.ok ? await removedRes.json() : [];
      } catch (err) {
        subtitle.textContent = 'Failed to load data: ' + err.message;
        return;
      }

      state.data.new = newLog.map((e) => ({
        appId: e['App ID'],
        name: e['Name'],
        developerName: e['Developer Name'],
        version: e['Version'],
        sourceRepository: e['Source Repository'],
        communityTopicId: e['Community Topic ID'] || null,
        discoveredAt: e['Discovered At'],
      }));

      state.data.all = snapshot.map((a) => ({ ...a }));

      state.data.retired = removed.map((r) => ({ ...r }));

      subtitle.textContent = state.data.new.length + ' new app(s) detected so far, out of ' +
        state.data.all.length + ' apps currently in the store (' + state.data.retired.length + ' retired).';

      renderTab(state.activeTab);
    }

    init();
  </script>
</body>
</html>
`;

function main() {
  fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });

  const newAppsLog = loadNewAppsLogAsJson();
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'new-apps-log.json'), JSON.stringify(newAppsLog, null, 2), 'utf8');

  const snapshot = loadSnapshot();
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'homey-apps-snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');

  const removed = loadRemovedAppsForPublic();
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'removed-apps.json'), JSON.stringify(removed, null, 2), 'utf8');

  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), INDEX_HTML, 'utf8');

  console.log(`Built public/index.html + data files: ${newAppsLog.length} new-app log entries, ${snapshot.length} apps in snapshot, ${removed.length} retired apps.`);
}

main();