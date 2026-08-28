/**
 * Builds a small static site (public/index.html) with two views:
 *   1. Newly discovered apps, from data/homey-new-apps-log.csv.
 *   2. The last 20 apps published or updated (by stateChangedAt),
 *      from data/homey-apps-snapshot.json -- toggled via a button.
 *
 * Run with:
 *   node scripts/build-site.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');
const LOG_FILE = path.join(DATA_DIR, 'homey-new-apps-log.csv');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'homey-apps-snapshot.json');
const RECENT_COUNT = 20;

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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadEntries() {
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

function loadRecentApps() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return [];
  let apps;
  try {
    apps = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return [];
  }
  return apps
    .filter((a) => a.publishedAt)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, RECENT_COUNT);
}

function buildRow(cells, searchText) {
  return `
        <tr data-search="${escapeHtml(searchText.toLowerCase())}">
          ${cells.join('\n          ')}
        </tr>`;
}

function sourceCell(sourceRepository) {
  return sourceRepository
    ? `<td><a href="${escapeHtml(sourceRepository)}" target="_blank" rel="noopener">source</a></td>`
    : `<td><span class="muted">—</span></td>`;
}

function buildHtml(newAppEntries, recentApps) {
  // Newest discoveries first.
  newAppEntries.sort((a, b) => new Date(b['Discovered At']) - new Date(a['Discovered At']));

  const newAppsRows = newAppEntries
    .map((e) => {
      const storeUrl = `https://homey.app/a/${encodeURIComponent(e['App ID'])}`;
      return buildRow(
        [
          `<td>${escapeHtml(e['Discovered At'] ? e['Discovered At'].slice(0, 10) : '')}</td>`,
          `<td><a href="${storeUrl}" target="_blank" rel="noopener">${escapeHtml(e['Name'])}</a></td>`,
          `<td class="muted">${escapeHtml(e['App ID'])}</td>`,
          `<td>${escapeHtml(e['Developer Name'])}</td>`,
          `<td>${escapeHtml(e['Version'])}</td>`,
          sourceCell(e['Source Repository']),
        ],
        `${e['Name']} ${e['Developer Name']}`
      );
    })
    .join('\n');

  const recentRows = recentApps
    .map((a) => {
      const storeUrl = `https://homey.app/a/${encodeURIComponent(a.appId)}`;
      return buildRow(
        [
          `<td>${escapeHtml(a.publishedAt ? a.publishedAt.slice(0, 10) : '')}</td>`,
          `<td><a href="${storeUrl}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a></td>`,
          `<td class="muted">${escapeHtml(a.appId)}</td>`,
          `<td>${escapeHtml(a.developerName)}</td>`,
          `<td>${escapeHtml(a.version)}</td>`,
          sourceCell(a.sourceRepository),
        ],
        `${a.name} ${a.developerName}`
      );
    })
    .join('\n');

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>New Homey Apps</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin-bottom: 0.25rem; }
  .subtitle { color: #666; margin-top: 0; margin-bottom: 1.5rem; }
  .controls { display: flex; gap: 0.6rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
  input#search { flex: 1; min-width: 200px; padding: 0.6rem 0.8rem; font-size: 1rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
  button#toggle-view { padding: 0.6rem 1rem; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 6px; background: Canvas; color: CanvasText; cursor: pointer; white-space: nowrap; }
  button#toggle-view:hover { background: rgba(127,127,127,0.12); }
  table { width: 100%; border-collapse: collapse; display: none; }
  table.active { display: table; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.92rem; }
  th { position: sticky; top: 0; background: Canvas; }
  tr:hover { background: rgba(127,127,127,0.08); }
  .muted { color: #888; font-size: 0.85em; }
  footer { margin-top: 2rem; color: #888; font-size: 0.85em; }
  a { color: #2b6cb0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { padding: 2rem 0; color: #888; text-align: center; }
  h2.view-title { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
</style>
</head>
<body>
  <h1>New Homey Apps</h1>
  <p class="subtitle">Newly published apps detected on the Homey App Store, tracked via daily snapshots. ${newAppEntries.length} total detected so far.</p>

  <div class="controls">
    <input id="search" type="search" placeholder="Filter by app name or developer..." autocomplete="off">
    <button id="toggle-view" type="button">Show last ${RECENT_COUNT} published/updated</button>
  </div>

  <h2 class="view-title" id="new-apps-title">Newly detected apps</h2>
  <table id="new-apps-table" class="active">
    <thead>
      <tr>
        <th>Discovered</th>
        <th>Name</th>
        <th>App ID</th>
        <th>Developer</th>
        <th>Version</th>
        <th>Source</th>
      </tr>
    </thead>
    <tbody>
      ${newAppsRows || ''}
    </tbody>
  </table>
  ${newAppEntries.length === 0 ? '<p class="empty" id="new-apps-empty">No new apps detected yet. Check back after the next scheduled run.</p>' : ''}

  <h2 class="view-title" id="recent-title" style="display:none;">Last ${RECENT_COUNT} published or updated</h2>
  <table id="recent-table">
    <thead>
      <tr>
        <th>Published/Updated</th>
        <th>Name</th>
        <th>App ID</th>
        <th>Developer</th>
        <th>Version</th>
        <th>Source</th>
      </tr>
    </thead>
    <tbody>
      ${recentRows || ''}
    </tbody>
  </table>
  ${recentApps.length === 0 ? '<p class="empty" id="recent-empty" style="display:none;">No data yet. Check back after the next scheduled run.</p>' : ''}

  <footer>Last updated ${generatedAt}. Data sourced from Athom's app-store API (apps-api.athom.com), sampled once per day. "Published/Updated" reflects the app's most recent publish event -- it can't distinguish a brand-new app from an existing app that just shipped a new version.</footer>

  <script>
    const input = document.getElementById('search');
    const toggleBtn = document.getElementById('toggle-view');
    const newTable = document.getElementById('new-apps-table');
    const recentTable = document.getElementById('recent-table');
    const newTitle = document.getElementById('new-apps-title');
    const recentTitle = document.getElementById('recent-title');
    const newEmpty = document.getElementById('new-apps-empty');
    const recentEmpty = document.getElementById('recent-empty');

    let showingRecent = false;

    function applyFilter() {
      const q = input.value.trim().toLowerCase();
      const activeTable = showingRecent ? recentTable : newTable;
      const rows = activeTable.querySelectorAll('tbody tr');
      for (const row of rows) {
        row.style.display = row.dataset.search.includes(q) ? '' : 'none';
      }
    }

    toggleBtn.addEventListener('click', () => {
      showingRecent = !showingRecent;
      newTable.classList.toggle('active', !showingRecent);
      recentTable.classList.toggle('active', showingRecent);
      newTitle.style.display = showingRecent ? 'none' : '';
      recentTitle.style.display = showingRecent ? '' : 'none';
      if (newEmpty) newEmpty.style.display = showingRecent ? 'none' : (newTable.querySelector('tbody tr') ? 'none' : '');
      if (recentEmpty) recentEmpty.style.display = showingRecent ? (recentTable.querySelector('tbody tr') ? 'none' : '') : 'none';
      toggleBtn.textContent = showingRecent ? 'Show newly detected apps' : 'Show last ${RECENT_COUNT} published/updated';
      applyFilter();
    });

    input.addEventListener('input', applyFilter);
  </script>
</body>
</html>
`;
}

function main() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const entries = loadEntries();
  const recentApps = loadRecentApps();
  const html = buildHtml(entries, recentApps);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');
  console.log(`Built public/index.html with ${entries.length} new-app entries and ${recentApps.length} recent-apps entries.`);
}

main();