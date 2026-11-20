/* ─── EPC Accounting Portal — data file (EPCDataFile) ─────────────────────────
 * "Download all data" first reads everything from the database (every saved
 * copy, every sales day and inventory day since the first upload; the cost is
 * shown and confirmed first), then writes it all as one file:
 * epc-data-<yyyy-mm-dd>.json. In Offline mode it saves what the browser has.
 * "Load from file" fills another browser's saved copies from it, so a new
 * laptop or colleague does not pay a full first load. The file holds real
 * business data: it is never uploaded anywhere by the site, and the repo and
 * Hosting ignore epc-data-*.json. Pure parts run in Node for the tests.
 *
 * Pages add the buttons with data attributes and this file wires them:
 *   <button data-epc-download>…</button>  <button data-epc-load>…</button>
 *   <span data-epc-datafile-status></span>
 */
(function (global) {
  const VERSION = 1;
  const NOT_A_FILE = 'This is not an EPC data file.';
  const OTHER_ACCOUNT = 'This file was downloaded by another account.';

  function build(uid, saved, days, at) {
    return { v: VERSION, uid, at: at != null ? at : Date.now(), saved: saved || {}, days: days || {} };
  }
  // { records, days, from, to } for a confirm message or a tooltip.
  function describe(file) {
    const saved = (file && file.saved) || {};
    const records = Object.keys(saved).reduce((n, k) => n + Object.keys((saved[k] && saved[k].docs) || {}).length, 0);
    const sales = ((file && file.days) || {}).salesDaily || {};
    const dates = Object.keys(sales.days || {}).sort();
    return { records, days: dates.length, from: dates[0] || '', to: dates[dates.length - 1] || '' };
  }
  function validate(file, uid) {
    if (!file || typeof file !== 'object' || file.v !== VERSION || !file.saved || !file.days) return { ok: false, reason: NOT_A_FILE };
    if (file.uid !== uid) return { ok: false, reason: OTHER_ACCOUNT };
    return { ok: true };
  }
  // Writes nothing unless the file is valid for this user.
  async function importInto(file, uid, io) {
    const check = validate(file, uid);
    if (!check.ok) throw new Error(check.reason);
    await io.importSaved(file.saved);
    await io.importDays(file.days);
  }

  // ── browser parts ────────────────────────────────────────────────────────
  function currentUid() {
    try { return global.firebase.auth().currentUser ? global.firebase.auth().currentUser.uid : null; } catch (e) { return null; }
  }
  async function gather() {
    const uid = currentUid();
    if (!uid) throw new Error('Please sign in first.');
    const saved = global.EPCSaved && global.EPCSaved.exportAll ? await global.EPCSaved.exportAll() : {};
    const days = global.EPCDays && global.EPCDays.exportAll ? await global.EPCDays.exportAll() : {};
    return build(uid, saved, days);
  }
  function fileName(at) {
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    return `epc-data-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
  }
  // What a download will read: every saved copy, and the chosen dates of sales and inventory days.
  function fullLoadParts(sourceNames, from, to) {
    return [
      ...sourceNames.map((name) => ({ saved: name })),
      { days: 'salesDaily', from, to },
      { days: 'inventoryDaily', from, to },
    ];
  }
  // Only the chosen dates go into the file (the saved copies are whole collections).
  function restrictDays(daysExport, from, to) {
    const out = {};
    Object.keys(daysExport || {}).forEach((c) => {
      const v = daysExport[c] || {};
      const days = {};
      Object.keys(v.days || {}).forEach((d) => { if (d >= from && d <= to) days[d] = v.days[d]; });
      out[c] = { stamp: v.stamp || null, covered: (v.covered || []).filter((d) => d >= from && d <= to), days };
    });
    return out;
  }
  // Ask for the dates first. Resolves { from, to } or null (cancel).
  function askRange() {
    const doc = global.document;
    const today = global.EPCDays.isoToday();
    const first = global.EPCDays.firstDayKnown('salesDaily') || `${today.slice(0, 4)}-01-01`;
    return new Promise((resolve) => {
      const overlay = doc.createElement('div');
      overlay.className = 'epc-loading-overlay epc-confirm';
      overlay.innerHTML = `<div class="epc-loading-card epc-confirm-card" role="dialog" aria-modal="true">
        <div class="epc-loading-msg">Download all data</div>
        <p class="epc-confirm-sum">Which sales and inventory days should the file hold? Every record of the other lists (purchases, expenses, products, …) is included whatever the dates.${global.EPC_OFFLINE ? ' Offline is on: only days already saved on this browser can go in.' : ' Days not yet saved on this browser are read from the database first (one read per day).'}</p>
        <div class="epc-range-row"><label>From <input type="date" id="epc-dl-from" class="form-input" value="${esc(first)}"></label>
        <label>To <input type="date" id="epc-dl-to" class="form-input" value="${esc(today)}"></label></div>
        <div class="epc-confirm-actions">
          <button type="button" class="btn btn-outline-gray" data-act="no">Cancel</button>
          <button type="button" class="btn btn-primary" data-act="yes">Next</button>
        </div></div>`;
      overlay.addEventListener('click', (ev) => {
        const act = ev.target && ev.target.dataset ? ev.target.dataset.act : null;
        if (!act) return;
        const from = overlay.querySelector('#epc-dl-from').value;
        const to = overlay.querySelector('#epc-dl-to').value;
        if (act === 'yes' && (!from || !to || from > to)) { overlay.querySelector('.epc-confirm-sum').textContent = 'Please pick a From date that is not after the To date.'; return; }
        overlay.remove();
        resolve(act === 'yes' ? { from, to } : null);
      });
      doc.body.appendChild(overlay);
    });
  }
  // Read the chosen days (and the saved copies) once so the file is complete.
  // Returns false on "Not now".
  async function loadEverything(range) {
    if (global.EPC_OFFLINE) return true;
    const sources = Object.keys(global.EPCSaved.SOURCES || {});
    if (!(await global.EPCReads.confirm(fullLoadParts(sources, range.from, range.to)))) return false;
    for (const name of sources) await global.EPCSaved.rows(name);
    await global.EPCDays.docs('salesDaily', range.from, range.to);
    await global.EPCDays.docs('inventoryDaily', range.from, range.to);
    return true;
  }
  async function download() {
    const range = await askRange();
    if (!range) return null;
    if (!(await loadEverything(range))) return null;
    const file = await gather();
    file.days = restrictDays(file.days, range.from, range.to);
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = global.document.createElement('a');
    a.href = url;
    a.download = fileName(file.at);
    global.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return describe(file);
  }
  function readJsonFile(input) {
    return new Promise((resolve, reject) => {
      const f = input.files && input.files[0];
      if (!f) { reject(new Error('No file chosen.')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.onload = () => {
        try { resolve(JSON.parse(reader.result)); } catch (e) { reject(new Error(NOT_A_FILE)); }
      };
      reader.readAsText(f);
    });
  }
  async function load(input) {
    const uid = currentUid();
    if (!uid) throw new Error('Please sign in first.');
    const file = await readJsonFile(input);
    const check = validate(file, uid);
    if (!check.ok) throw new Error(check.reason);
    const d = describe(file);
    const when = new Date(file.at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    const ok = global.confirm(`Load this file? It has ${d.records.toLocaleString()} records and ${d.days.toLocaleString()} sales days` +
      `${d.from ? ` (${d.from} to ${d.to})` : ''}, downloaded ${when}. It replaces the copy saved on this browser.`);
    if (!ok) return null;
    await importInto(file, uid, {
      importSaved: (s) => global.EPCSaved.importAll(s),
      importDays: (dd) => global.EPCDays.importAll(dd),
    });
    return d;
  }
  async function tooltip() {
    try {
      const d = describe(await gather());
      return d.records || d.days
        ? `${d.records.toLocaleString()} records and ${d.days.toLocaleString()} sales days${d.from ? ` (${d.from} to ${d.to})` : ''} saved on this browser.`
        : 'Nothing saved on this browser yet. Generate a report first.';
    } catch (e) { return ''; }
  }
  // Wire any [data-epc-download] / [data-epc-load] buttons on the page.
  function wire() {
    const doc = global.document;
    const status = doc.querySelector('[data-epc-datafile-status]');
    const say = (t) => { if (status) status.textContent = t; };
    doc.querySelectorAll('[data-epc-download]').forEach((btn) => {
      tooltip().then((t) => { if (t) btn.title = t; });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        say(global.EPC_OFFLINE ? 'Saving the copy on this browser…' : 'Reading everything from the database first…');
        try {
          const d = await download();
          if (d) say(`Downloaded ${d.records.toLocaleString()} records and ${d.days.toLocaleString()} sales days.`);
          else say('');
          if (d) global.dispatchEvent(new Event('epc-cost-change'));
        } catch (e) { say(e.message || 'Could not download.'); } finally { btn.disabled = false; }
      });
    });
    doc.querySelectorAll('[data-epc-load]').forEach((btn) => {
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.hidden = true;
      btn.insertAdjacentElement('afterend', input);
      btn.addEventListener('click', () => { input.value = ''; input.click(); });
      input.addEventListener('change', async () => {
        btn.disabled = true;
        try {
          const d = await load(input);
          if (d) say(`Loaded ${d.records.toLocaleString()} records and ${d.days.toLocaleString()} sales days. Generate a report to use them.`);
          if (d) global.dispatchEvent(new Event('epc-cost-change'));
        } catch (e) { say(e.message || 'Could not load the file.'); } finally { btn.disabled = false; }
      });
    });
  }
  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  const api = { VERSION, build, describe, validate, importInto, fullLoadParts, restrictDays, download, load, wire };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.EPCDataFile = api;
})(typeof window !== 'undefined' ? window : globalThis);
