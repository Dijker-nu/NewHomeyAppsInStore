/**
 * Prepares the static site in public/:
 *   - Converts data/homey-new-apps-log.csv to public/data/new-apps-log.json
 *   - Copies data/homey-apps-snapshot.json to public/data/homey-apps-snapshot.json
 *   - Writes public/index.html, a static shell that fetches both JSON
 *     files client-side and renders everything in the browser (no data
 *     is baked into the HTML at build time).
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
  .controls { display: flex; gap: 0.6rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
  input#search { flex: 1; min-width: 200px; padding: 0.6rem 0.8rem; font-size: 1rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
  button#toggle-view { padding: 0.6rem 1rem; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 6px; background: Canvas; color: CanvasText; cursor: pointer; white-space: nowrap; }
  button#toggle-view:hover { background: rgba(127,127,127,0.12); }
  table { width: 100%; border-collapse: collapse; display: none; }
  table.active { display: table; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.92rem; vertical-align: middle; }
  th { position: sticky; top: 0; background: Canvas; }
  tr:hover { background: rgba(127,127,127,0.08); }
  .muted { color: #888; font-size: 0.85em; }
  footer { margin-top: 2rem; color: #888; font-size: 0.85em; }
  a { color: #2b6cb0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { padding: 2rem 0; color: #888; text-align: center; }
  .caption { color: #888; font-size: 0.85em; margin: 0.5rem 0 0; }
  h2.view-title { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
  .copy-btn { padding: 0.3rem 0.7rem; font-size: 0.82rem; border: 1px solid #ccc; border-radius: 5px; background: Canvas; color: CanvasText; cursor: pointer; }
  .copy-btn:hover { background: rgba(127,127,127,0.12); }
  .copy-btn:disabled { opacity: 0.7; cursor: default; }
</style>
</head>
<body>
  <h1>New Homey Apps</h1>
  <p class="subtitle" id="subtitle">Loading data...</p>

  <div class="controls">
    <input id="search" type="search" placeholder="Filter by app name or developer..." autocomplete="off">
    <button id="toggle-view" type="button">Show All Apps</button>
  </div>

  <h2 class="view-title" id="new-apps-title">Newly detected apps</h2>
  <table id="new-apps-table" class="active">
    <thead>
      <tr><th>Discovered</th><th>Name</th><th>App ID</th><th>Developer</th><th>Version</th><th>Source</th><th>Forum post</th></tr>
    </thead>
    <tbody id="new-apps-body"></tbody>
  </table>
  <p class="empty" id="new-apps-empty" style="display:none;"></p>

  <h2 class="view-title" id="all-apps-title" style="display:none;">All apps</h2>
  <table id="all-apps-table">
    <thead>
      <tr><th>Published/Updated</th><th>Name</th><th>App ID</th><th>Developer</th><th>Version</th><th>Source</th><th>Forum post</th></tr>
    </thead>
    <tbody id="all-apps-body"></tbody>
  </table>
  <p class="caption" id="all-apps-caption" style="display:none;"></p>
  <p class="empty" id="all-apps-empty" style="display:none;"></p>

  <footer>Data sourced from Athom's app-store API (apps-api.athom.com), sampled once per day. "Published/Updated" reflects each app's most recent publish event -- it can't distinguish a brand-new app from an existing app that just shipped a new version. The "Forum post" copy button builds the text suggested by <a href="https://community.homey.app/t/list-new-published-app-in-homey-app-store-get-em-while-theyre-hot/100276" target="_blank" rel="noopener">this Homey Community topic's guideline</a> -- review it before posting.</footer>

  <script>
    const NEW_APPS_URL = './data/new-apps-log.json';
    const SNAPSHOT_URL = './data/homey-apps-snapshot.json';
    const RECENT_LIMIT = 20;

    let newAppsData = [];
    let allAppsData = [];
    let showingAll = false;

    const input = document.getElementById('search');
    const toggleBtn = document.getElementById('toggle-view');
    const newTable = document.getElementById('new-apps-table');
    const allTable = document.getElementById('all-apps-table');
    const newTitle = document.getElementById('new-apps-title');
    const allTitle = document.getElementById('all-apps-title');
    const newBody = document.getElementById('new-apps-body');
    const allBody = document.getElementById('all-apps-body');
    const newEmpty = document.getElementById('new-apps-empty');
    const allEmpty = document.getElementById('all-apps-empty');
    const allCaption = document.getElementById('all-apps-caption');
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

    function renderRow(app, dateValue) {
      const storeUrl = 'https://homey.app/a/' + encodeURIComponent(app.appId);
      const source = app.sourceRepository
        ? '<a href="' + escapeHtml(app.sourceRepository) + '" target="_blank" rel="noopener">source</a>'
        : '<span class="muted">—</span>';

      const tr = document.createElement('tr');
      tr.dataset.search = ((app.name || '') + ' ' + (app.developerName || '')).toLowerCase();
      tr.innerHTML =
        '<td>' + escapeHtml(dateValue ? String(dateValue).slice(0, 10) : '') + '</td>' +
        '<td><a href="' + storeUrl + '" target="_blank" rel="noopener">' + escapeHtml(app.name) + '</a></td>' +
        '<td class="muted">' + escapeHtml(app.appId) + '</td>' +
        '<td>' + escapeHtml(app.developerName) + '</td>' +
        '<td>' + escapeHtml(app.version) + '</td>' +
        '<td>' + source + '</td>' +
        '<td><button class="copy-btn" type="button">Copy</button></td>';

      tr.querySelector('.copy-btn').addEventListener('click', (ev) => {
        copyToClipboard(buildForumPost(app), ev.currentTarget);
      });

      return tr;
    }

    function currentQuery() {
      return input.value.trim().toLowerCase();
    }

    function renderNewApps() {
      newBody.innerHTML = '';
      const q = currentQuery();
      const filtered = newAppsData.filter((e) =>
        ((e['Name'] || '') + ' ' + (e['Developer Name'] || '')).toLowerCase().includes(q)
      );
      filtered.sort((a, b) => new Date(b['Discovered At']) - new Date(a['Discovered At']));

      for (const e of filtered) {
        const app = {
          appId: e['App ID'],
          name: e['Name'],
          developerName: e['Developer Name'],
          version: e['Version'],
          sourceRepository: e['Source Repository'],
          communityTopicId: e['Community Topic ID'] || null,
        };
        newBody.appendChild(renderRow(app, e['Discovered At']));
      }

      if (newAppsData.length === 0) {
        newEmpty.textContent = 'No new apps detected yet. Check back after the next scheduled run.';
        newEmpty.style.display = '';
      } else if (filtered.length === 0) {
        newEmpty.textContent = 'No matches for that search.';
        newEmpty.style.display = '';
      } else {
        newEmpty.style.display = 'none';
      }
    }

    function renderAllApps() {
      allBody.innerHTML = '';
      const q = currentQuery();
      const filtered = allAppsData.filter((a) =>
        ((a.name || '') + ' ' + (a.developerName || '')).toLowerCase().includes(q)
      );
      filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const shown = filtered.slice(0, RECENT_LIMIT);

      for (const app of shown) {
        allBody.appendChild(renderRow(app, app.publishedAt));
      }

      if (allAppsData.length === 0) {
        allEmpty.textContent = 'No data yet. Check back after the next scheduled run.';
        allEmpty.style.display = '';
        allCaption.style.display = 'none';
      } else if (shown.length === 0) {
        allEmpty.textContent = 'No matches for that search.';
        allEmpty.style.display = '';
        allCaption.style.display = 'none';
      } else {
        allEmpty.style.display = 'none';
        allCaption.style.display = '';
        allCaption.textContent = filtered.length > RECENT_LIMIT
          ? 'Showing ' + shown.length + ' of ' + filtered.length + ' matching apps -- refine your search to narrow further.'
          : 'Showing ' + shown.length + ' of ' + filtered.length + ' matching apps.';
      }
    }

    function render() {
      if (showingAll) renderAllApps(); else renderNewApps();
    }

    toggleBtn.addEventListener('click', () => {
      showingAll = !showingAll;
      newTable.classList.toggle('active', !showingAll);
      allTable.classList.toggle('active', showingAll);
      newTitle.style.display = showingAll ? 'none' : '';
      allTitle.style.display = showingAll ? '' : 'none';
      if (!showingAll) allCaption.style.display = 'none';
      toggleBtn.textContent = showingAll ? 'Show newly detected apps' : 'Show All Apps';
      render();
    });

    input.addEventListener('input', render);

    async function init() {
      try {
        const [newRes, snapRes] = await Promise.all([fetch(NEW_APPS_URL), fetch(SNAPSHOT_URL)]);
        newAppsData = newRes.ok ? await newRes.json() : [];
        allAppsData = snapRes.ok ? await snapRes.json() : [];
      } catch (err) {
        subtitle.textContent = 'Failed to load data: ' + err.message;
        return;
      }

      subtitle.textContent = newAppsData.length + ' new app(s) detected so far, out of ' + allAppsData.length + ' apps currently in the store.';
      render();
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

  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), INDEX_HTML, 'utf8');

  console.log(`Built public/index.html + data files: ${newAppsLog.length} new-app log entries, ${snapshot.length} apps in full snapshot.`);
}

main();
