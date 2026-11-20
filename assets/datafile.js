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
  // What a full download will read: every saved copy, every sales and inventory day.
  function fullLoadParts(sourceNames, allParts) {
    return [
      ...sourceNames.map((name) => ({ saved: name })),
      ...allParts('salesDaily'),
      ...allParts('inventoryDaily'),
    ];
  }
  // Read everything once so the file is complete (one read per day the first
  // time on a browser, about 2 per collection after that). Returns false on "Not now".
  async function loadEverything() {
    if (global.EPC_OFFLINE) return true;
    const sources = Object.keys(global.EPCSaved.SOURCES || {});
    const parts = fullLoadParts(sources, (c) => global.EPCDays.allParts(c));
    if (!(await global.EPCReads.confirm(parts))) return false;
    for (const name of sources) await global.EPCSaved.rows(name);
    await global.EPCDays.all('salesDaily');
    await global.EPCDays.all('inventoryDaily');
    return true;
  }
  async function download() {
    if (!(await loadEverything())) return null;
    const file = await gather();
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

  const api = { VERSION, build, describe, validate, importInto, fullLoadParts, download, load, wire };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.EPCDataFile = api;
})(typeof window !== 'undefined' ? window : globalThis);
