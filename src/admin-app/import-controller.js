function dispatchAdminEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function showImportCandidates(candidates, extra) {
  const detail = { status: 'ready', candidates: Array.isArray(candidates) ? candidates : [] };
  if (extra && Array.isArray(extra.standings)) detail.standings = extra.standings;
  if (extra && extra.sourceUrl) detail.sourceUrl = extra.sourceUrl;
  if (extra && extra.mode) detail.mode = extra.mode;
  dispatchAdminEvent('gvdg:admin-import-candidates', detail);
}

export async function adminDgsImportFromReact(detail, { adminApi, adminMsg }) {
  const requestId = detail.requestId;
  if (!requestId) return;
  adminMsg('Importing from DiscGolfScene...', true);
  dispatchAdminEvent('gvdg:admin-import-candidates', { status: 'loading', candidates: [] });
  let r;
  try {
    r = await adminApi('/admin/import/dgs', { method: 'POST', body: {} });
  } catch (err) {
    adminMsg('DGS import failed', false);
    dispatchAdminEvent('gvdg:admin-dgs-import-result', { ok: false, requestId });
    return;
  }
  if (r.ok) {
    const d = await r.json();
    showImportCandidates(d.candidates);
    adminMsg((d.candidates || []).length + ' candidates loaded', true);
    dispatchAdminEvent('gvdg:admin-dgs-import-result', { ok: true, requestId });
  } else {
    adminMsg('DGS import failed (' + r.status + ')', false);
    dispatchAdminEvent('gvdg:admin-dgs-import-result', { ok: false, requestId });
  }
}

export async function adminCsvImportFromReact(detail, { adminApi, adminMsg }) {
  const requestId = detail.requestId;
  if (!requestId) return;
  const csv = typeof detail.csv === 'string' ? detail.csv : '';
  if (detail.valid !== true || !csv.trim()) {
    adminMsg('Paste CSV first', false);
    dispatchAdminEvent('gvdg:admin-csv-import-result', { ok: false, requestId });
    return;
  }
  dispatchAdminEvent('gvdg:admin-import-candidates', { status: 'loading', candidates: [] });
  let r;
  try {
    r = await adminApi('/admin/import/csv', { method: 'POST', body: { csv } });
  } catch (err) {
    adminMsg('CSV import failed', false);
    dispatchAdminEvent('gvdg:admin-csv-import-result', { ok: false, requestId });
    return;
  }
  if (r.ok) {
    const d = await r.json();
    showImportCandidates(d.candidates);
    adminMsg((d.candidates || []).length + ' rows parsed', true);
    dispatchAdminEvent('gvdg:admin-csv-import-result', { ok: true, requestId });
  } else {
    adminMsg('CSV import failed (' + r.status + ')', false);
    dispatchAdminEvent('gvdg:admin-csv-import-result', { ok: false, requestId });
  }
}

export async function adminUdiscEventsImportFromReact(detail, { adminApi, adminMsg }) {
  const requestId = detail.requestId;
  if (!requestId) return;
  const url = typeof detail.url === 'string' ? detail.url.trim() : '';
  if (detail.valid !== true || !url) {
    adminMsg('Paste a UDisc league or event link', false);
    dispatchAdminEvent('gvdg:admin-udisc-events-import-result', { ok: false, requestId });
    return;
  }
  dispatchAdminEvent('gvdg:admin-import-candidates', { status: 'loading', candidates: [] });
  let r;
  try {
    r = await adminApi('/admin/import/udisc-events', { method: 'POST', body: { url } });
  } catch (err) {
    adminMsg('UDisc import failed', false);
    dispatchAdminEvent('gvdg:admin-udisc-events-import-result', { ok: false, requestId });
    return;
  }
  if (r.ok) {
    const d = await r.json();
    showImportCandidates(d.candidates, { standings: d.standings, sourceUrl: url, mode: d.standings_mode });
    const count = (d.candidates || []).length;
    const players = Array.isArray(d.standings) ? d.standings.length : 0;
    adminMsg(count + ' UDisc row' + (count === 1 ? '' : 's') + (players ? ', standings for ' + players + ' players' : '') + (d.truncated ? ' (first pages only)' : ''), true);
    dispatchAdminEvent('gvdg:admin-udisc-events-import-result', { ok: true, requestId });
  } else {
    adminMsg('UDisc import failed (' + r.status + ')', false);
    dispatchAdminEvent('gvdg:admin-udisc-events-import-result', { ok: false, requestId });
  }
}

export async function adminUdiscSaveFromReact(detail, { adminApi, adminMsg }) {
  const requestId = detail.requestId;
  if (!requestId) return;
  const url = typeof detail.url === 'string' ? detail.url.trim() : '';
  if (!url) {
    adminMsg('Import the UDisc league again, then save the results', false);
    dispatchAdminEvent('gvdg:admin-udisc-save-result', { ok: false, requestId });
    return;
  }
  let r;
  try {
    r = await adminApi('/admin/import/udisc-league', { method: 'POST', body: { save: true, url } });
  } catch (err) {
    adminMsg('Could not save the UDisc results', false);
    dispatchAdminEvent('gvdg:admin-udisc-save-result', { ok: false, requestId });
    return;
  }
  if (!r.ok) {
    adminMsg('Could not save the UDisc results (' + r.status + ')', false);
    dispatchAdminEvent('gvdg:admin-udisc-save-result', { ok: false, requestId });
    return;
  }
  const saved = await r.json();
  adminMsg('Saved ' + (saved.events || 0) + ' rounds and ' + (saved.results || 0) + ' scores. Standings are on the league page.', true);
  dispatchAdminEvent('gvdg:admin-udisc-save-result', { ok: true, requestId });
}

export function installImportController(deps) {
  window.addEventListener('gvdg:admin-dgs-import-request', async (event) => {
    await adminDgsImportFromReact(event.detail || {}, deps);
  });
  window.addEventListener('gvdg:admin-csv-import-request', async (event) => {
    await adminCsvImportFromReact(event.detail || {}, deps);
  });
  window.addEventListener('gvdg:admin-udisc-events-import-request', async (event) => {
    await adminUdiscEventsImportFromReact(event.detail || {}, deps);
  });
  window.addEventListener('gvdg:admin-udisc-save-request', async (event) => {
    await adminUdiscSaveFromReact(event.detail || {}, deps);
  });
}
