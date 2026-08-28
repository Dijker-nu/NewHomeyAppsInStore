/**
 * Builds a small static site (public/index.html) listing newly
 * discovered Homey apps, from data/homey-new-apps-log.csv.
 *
 * Run with:
 *   node scripts/build-site.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');
const LOG_FILE = path.join(DATA_DIR, 'homey-new-apps-log.csv');

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

function buildHtml(entries) {
  // Newest discoveries first.
  entries.sort((a, b) => new Date(b['Discovered At']) - new Date(a['Discovered At']));

  const rowsHtml = entries
    .map((e) => {
      const storeUrl = `https://homey.app/a/${encodeURIComponent(e['App ID'])}`;
      const sourceCell = e['Source Repository']
        ? `<a href="${escapeHtml(e['Source Repository'])}" target="_blank" rel="noopener">source</a>`
        : '<span class="muted">—</span>';
      return `
        <tr data-search="${escapeHtml((e['Name'] + ' ' + e['Developer Name']).toLowerCase())}">
          <td>${escapeHtml(e['Discovered At'] ? e['Discovered At'].slice(0, 10) : '')}</td>
          <td><a href="${storeUrl}" target="_blank" rel="noopener">${escapeHtml(e['Name'])}</a></td>
          <td class="muted">${escapeHtml(e['App ID'])}</td>
          <td>${escapeHtml(e['Developer Name'])}</td>
          <td>${escapeHtml(e['Version'])}</td>
          <td>${sourceCell}</td>
        </tr>`;
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
  input#search { width: 100%; padding: 0.6rem 0.8rem; font-size: 1rem; box-sizing: border-box; margin-bottom: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.92rem; }
  th { position: sticky; top: 0; background: Canvas; }
  tr:hover { background: rgba(127,127,127,0.08); }
  .muted { color: #888; font-size: 0.85em; }
  footer { margin-top: 2rem; color: #888; font-size: 0.85em; }
  a { color: #2b6cb0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { padding: 2rem 0; color: #888; text-align: center; }
</style>
</head>
<body>
  <h1>New Homey Apps</h1>
  <p class="subtitle">Newly published apps detected on the Homey App Store, tracked via daily snapshots. ${entries.length} total detected so far.</p>

  <input id="search" type="search" placeholder="Filter by app name or developer..." autocomplete="off">

  <table id="apps-table">
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
      ${rowsHtml || ''}
    </tbody>
  </table>
  ${entries.length === 0 ? '<p class="empty">No new apps detected yet. Check back after the next scheduled run.</p>' : ''}

  <footer>Last updated ${generatedAt}. Data sourced from Athom's app-store API (apps-api.athom.com), sampled once per day.</footer>

  <script>
    const input = document.getElementById('search');
    const rows = Array.from(document.querySelectorAll('#apps-table tbody tr'));
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      for (const row of rows) {
        row.style.display = row.dataset.search.includes(q) ? '' : 'none';
      }
    });
  </script>
</body>
</html>
`;
}

function main() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const entries = loadEntries();
  const html = buildHtml(entries);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');
  console.log(`Built public/index.html with ${entries.length} entries.`);
}

main();
