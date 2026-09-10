/**
 * Prepares the static site in public/:
 *   - Copies data/homey-new-apps-log.json  -> public/data/new-apps-log.json
 *   - Copies data/homey-apps-snapshot.json -> public/data/homey-apps-snapshot.json
 *   - Copies data/homey-removed-apps.json  -> public/data/removed-apps.json
 *     (all three are already minimal, flat JSON -- no transform needed
 *     since discover-new-apps.js / update-apps.js write them in the
 *     shape the site wants directly)
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
const NEW_APPS_LOG_FILE = path.join(DATA_DIR, 'homey-new-apps-log.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'homey-apps-snapshot.json');
const REMOVED_FILE = path.join(DATA_DIR, 'homey-removed-apps.json');
const NEW_APPS_RETENTION_DAYS = 30;

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadNewAppsLog() {
  const entries = loadJson(NEW_APPS_LOG_FILE, []);
  // Defensive re-prune at build time too, in case a scheduled run was
  // skipped and an over-30-days entry is still sitting in the file.
  const cutoff = Date.now() - NEW_APPS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter((e) => e.discoveredAt && new Date(e.discoveredAt).getTime() >= cutoff);
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>New Homey Apps</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 1150px; margin: 2rem auto; padding: 0 1rem; }
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
  th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  th.sortable:hover { background: rgba(127,127,127,0.12); }
  th.sortable .arrow { opacity: 0.5; font-size: 0.8em; margin-left: 0.2em; }
  th.sortable.sorted .arrow { opacity: 1; }
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
    <thead>
      <tr>
        <th class="sortable" data-sort="publishedAt">Published <span class="arrow"></span></th>
        <th class="sortable" data-sort="updatedAt">Updated <span class="arrow"></span></th>
        <th>Name</th><th>App ID</th><th>Developer</th><th>Version</th><th>Source</th><th>Forum post</th>
      </tr>
    </thead>
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

  <footer>Data sourced from Athom's app-store API (apps-api.athom.com). New-app discovery runs every 4 hours; the full rescan (name/developer/version/topic-ID changes, plus removals) runs once a day, so "Updated" only moves when something actually changed. The "New Apps" list only keeps the last 30 days. The "Forum post" copy button builds the text suggested by <a href="https://community.homey.app/t/list-new-published-app-in-homey-app-store-get-em-while-theyre-hot/100276" target="_blank" rel="noopener">this Homey Community topic's guideline</a> -- review it before posting.</footer>

  <script>
    const PAGE_SIZE = 20;

    const state = {
      activeTab: 'new',
      visibleCount: { all: PAGE_SIZE, new: PAGE_SIZE, retired: PAGE_SIZE },
      data: { all: [], new: [], retired: [] },
      allSort: { column: 'publishedAt', direction: 'desc' },
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
    const sortableHeaders = Array.from(tables.all.querySelectorAll('th.sortable'));

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

    function dateCellHtml(value) {
      return escapeHtml(value ? String(value).slice(0, 10) : '');
    }

    function copyButtonCellHtml() {
      return '<td><button class="copy-btn" type="button">Copy</button></td>';
    }

    function attachCopyHandler(tr, app) {
      const btn = tr.querySelector('.copy-btn');
      if (btn) {
        btn.addEventListener('click', (ev) => copyToClipboard(buildForumPost(app), ev.currentTarget));
      }
    }

    function renderAllRow(app) {
      const storeUrl = 'https://homey.app/a/' + encodeURIComponent(app.appId);
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + dateCellHtml(app.publishedAt) + '</td>' +
        '<td>' + dateCellHtml(app.updatedAt) + '</td>' +
        '<td><a href="' + storeUrl + '" target="_blank" rel="noopener">' + escapeHtml(app.name) + '</a></td>' +
        '<td class="muted">' + escapeHtml(app.appId) + '</td>' +
        '<td>' + escapeHtml(app.developerName) + '</td>' +
        '<td>' + escapeHtml(app.version) + '</td>' +
        '<td>' + sourceCellHtml(app.sourceRepository) + '</td>' +
        copyButtonCellHtml();
      attachCopyHandler(tr, app);
      return tr;
    }

    function renderNewRow(app) {
      const storeUrl = 'https://homey.app/a/' + encodeURIComponent(app.appId);
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + dateCellHtml(app.discoveredAt) + '</td>' +
        '<td><a href="' + storeUrl + '" target="_blank" rel="noopener">' + escapeHtml(app.name) + '</a></td>' +
        '<td class="muted">' + escapeHtml(app.appId) + '</td>' +
        '<td>' + escapeHtml(app.developerName) + '</td>' +
        '<td>' + escapeHtml(app.version) + '</td>' +
        '<td>' + sourceCellHtml(app.sourceRepository) + '</td>' +
        copyButtonCellHtml();
      attachCopyHandler(tr, app);
      return tr;
    }

    function renderRetiredRow(app) {
      const storeUrl = 'https://homey.app/a/' + encodeURIComponent(app.appId);
      const privateBadge = app.private === true ? '<span class="badge">private</span>'
        : app.private === false ? '<span class="badge">public</span>'
        : '<span class="muted">—</span>';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + dateCellHtml(app.removedAt) + '</td>' +
        '<td><a href="' + storeUrl + '" target="_blank" rel="noopener">' + escapeHtml(app.name) + '</a></td>' +
        '<td class="muted">' + escapeHtml(app.appId) + '</td>' +
        '<td>' + escapeHtml(app.developerName) + '</td>' +
        '<td>' + escapeHtml(app.version) + '</td>' +
        '<td>' + privateBadge + '</td>' +
        '<td>' + sourceCellHtml(app.sourceRepository) + '</td>';
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
        const { column, direction } = state.allSort;
        const dir = direction === 'asc' ? 1 : -1;
        filtered.sort((a, b) => dir * (new Date(a[column] || 0) - new Date(b[column] || 0)));
      }
      return filtered;
    }

    function updateSortIndicators() {
      for (const th of sortableHeaders) {
        const col = th.dataset.sort;
        const isSorted = col === state.allSort.column;
        th.classList.toggle('sorted', isSorted);
        th.querySelector('.arrow').textContent = isSorted ? (state.allSort.direction === 'asc' ? '\\u25B2' : '\\u25BC') : '';
      }
    }

    function renderTab(tab) {
      const table = tables[tab];
      const tbody = table.querySelector('tbody');
      tbody.innerHTML = '';

      const q = currentQuery();
      const filtered = getSortedFiltered(tab, q);
      const shown = filtered.slice(0, state.visibleCount[tab]);

      const rowRenderer = tab === 'all' ? renderAllRow : tab === 'new' ? renderNewRow : renderRetiredRow;
      for (const app of shown) {
        tbody.appendChild(rowRenderer(app));
      }

      if (tab === 'all') updateSortIndicators();

      const emptyEl = emptyEls[tab];
      const captionEl = captionEls[tab];

      if (state.data[tab].length === 0) {
        emptyEl.textContent = tab === 'new'
          ? 'No new apps detected in the last 30 days.'
          : tab === 'retired'
            ? 'No retired apps detected yet.'
            : 'No data yet. Check back after the next scheduled run.';
        emptyEl.style.display = 'block';
        captionEl.style.display = 'none';
      } else if (shown.length === 0) {
        emptyEl.textContent = 'No matches for that search.';
        emptyEl.style.display = 'block';
        captionEl.style.display = 'none';
      } else {
        emptyEl.style.display = 'none';
        captionEl.style.display = 'block';
        captionEl.textContent = 'Showing ' + shown.length + ' of ' + filtered.length + ' matching app(s).';
      }

      loadMoreWrap.style.display = filtered.length > shown.length ? 'block' : 'none';
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

    sortableHeaders.forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (state.allSort.column === col) {
          state.allSort.direction = state.allSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          state.allSort.column = col;
          state.allSort.direction = 'desc';
        }
        renderTab('all');
      });
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

      state.data.new = newLog;
      state.data.all = snapshot;
      state.data.retired = removed;

      subtitle.textContent = state.data.new.length + ' new app(s) in the last 30 days, out of ' +
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

  const newAppsLog = loadNewAppsLog();
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'new-apps-log.json'), JSON.stringify(newAppsLog, null, 2), 'utf8');

  const snapshot = loadJson(SNAPSHOT_FILE, []);
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'homey-apps-snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');

  const removed = loadJson(REMOVED_FILE, []);
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'removed-apps.json'), JSON.stringify(removed, null, 2), 'utf8');

  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), INDEX_HTML, 'utf8');

  console.log(`Built public/index.html + data files: ${newAppsLog.length} new-app log entries, ${snapshot.length} apps in snapshot, ${removed.length} retired apps.`);
}

main();
