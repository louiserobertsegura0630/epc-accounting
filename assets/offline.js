/* ─── EPC Accounting Portal — site-wide Offline mode (EPCOffline) ─────────────
 * One sidebar button: "Switch to offline mode". In stages:
 *   1. If the copy on this browser is not complete (no sales days saved, or the
 *      core lists missing), run the same download as Settings' "Download all
 *      data" (dates box, read cost, confirm) without writing a file.
 *   2. Set the flag (localStorage epc_offline) and reload. From then on every
 *      Firebase read on every page is answered from the local cache (0 reads,
 *      see EPCReads.watchGet), the look changes (html[data-offline]) and a
 *      banner says so. "Switch back online" clears the flag and reloads.
 * Pure logic runs in Node for the tests; the DOM parts are below.
 */
(function (global) {
  const BANNER_TEXT = 'Offline mode: reading the copy saved on this browser, 0 database reads. Days or records not saved here are missing.';

  let deps = {
    isComplete: null,   // () => Promise<boolean>
    fill: null,         // () => Promise<boolean>  false = cancelled / not now
    setFlag: null,      // (on) => void
    reload: null,       // () => void
  };
  function _init(overrides) { deps = { ...deps, ...overrides }; }

  // Browser defaults.
  async function isCompleteDefault() {
    try {
      const days = global.EPCDays ? await global.EPCDays.cachedDates('salesDaily') : [];
      const meta = global.EPCSaved && global.EPCSaved.meta ? await global.EPCSaved.meta() : {};
      return days.length > 0 && !!meta.purchases && !!meta.productMaster;
    } catch (e) { return false; }
  }
  function fillDefault() {
    if (!global.EPCDataFile || !global.EPCDataFile.fill) return Promise.resolve(false);
    return global.EPCDataFile.fill();
  }
  function setFlagDefault(on) { if (global.EPCReads) global.EPCReads.setOffline(on); }
  function reloadDefault() { global.location.reload(); }

  const isComplete = () => (deps.isComplete || isCompleteDefault)();
  const fill = () => (deps.fill || fillDefault)();
  const setFlag = (on) => (deps.setFlag || setFlagDefault)(on);
  const reload = () => (deps.reload || reloadDefault)();

  function isOn() { return !!global.EPC_OFFLINE; }

  // Stage 1 (fill if needed), stage 2 (switch). Resolves false when stopped.
  async function switchOn() {
    if (!(await isComplete())) {
      const ok = await fill();
      if (!ok) return false;
    }
    setFlag(true);
    reload();
    return true;
  }
  async function switchOff() {
    setFlag(false);
    reload();
  }

  // ── DOM: the sidebar button and the banner ───────────────────────────────
  function labelFor(btn) {
    btn.textContent = isOn() ? 'Switch back online' : 'Switch to offline mode';
    btn.title = isOn()
      ? 'Go back to reading from the database.'
      : 'Read everything from the copy on this browser: 0 database reads. If the copy is not complete yet, it is filled first (you see the read cost).';
  }
  async function onClick(btn) {
    btn.disabled = true;
    try {
      if (isOn()) await switchOff();
      else {
        const done = await switchOn();
        if (!done) btn.disabled = false;
      }
    } catch (e) {
      console.error('[Offline] switch failed:', e);
      btn.disabled = false;
      if (global.alert) global.alert(`Could not switch: ${e.message || e}`);
    }
  }
  function wireButton() {
    const doc = global.document;
    const btn = doc.getElementById('epc-offline-btn');
    if (!btn) return;
    labelFor(btn);
    btn.addEventListener('click', () => onClick(btn));
  }
  function paintBanner() {
    const doc = global.document;
    if (!isOn() || !doc.body || doc.getElementById('epc-offline-banner')) return;
    const bar = doc.createElement('div');
    bar.id = 'epc-offline-banner';
    bar.className = 'epc-offline-banner';
    bar.setAttribute('role', 'status');
    const limited = global.EPC_PERSISTENCE === false;
    bar.innerHTML = `<span class="epc-offline-dot" aria-hidden="true"></span><span class="epc-offline-text"></span>` +
      `<button type="button" class="epc-offline-back">Switch back online</button>`;
    bar.querySelector('.epc-offline-text').textContent = BANNER_TEXT + (limited ? ' This browser could not keep Firebase’s local storage, so only Reports and the Dashboard have a copy.' : '');
    bar.querySelector('.epc-offline-back').addEventListener('click', (ev) => onClick(ev.currentTarget));
    doc.body.appendChild(bar);
    doc.body.classList.add('has-offline-banner');
  }
  function start() {
    wireButton();
    paintBanner();
    // The sidebar is rendered by initSidebar after load on some pages: watch for the button.
    if (global.MutationObserver && global.document.body && !global.document.getElementById('epc-offline-btn')) {
      const mo = new MutationObserver(() => {
        if (global.document.getElementById('epc-offline-btn')) { mo.disconnect(); wireButton(); }
      });
      mo.observe(global.document.body, { childList: true, subtree: true });
    }
  }
  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  const api = { BANNER_TEXT, isOn, switchOn, switchOff, _init };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.EPCOffline = api;
})(typeof window !== 'undefined' ? window : globalThis);
