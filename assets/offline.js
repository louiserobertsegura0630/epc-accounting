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
    uid: null, cachedDates: null, meta: null, storage: null,   // for tests
    persistenceOn: null, wantPersistence: null,
  };
  const PENDING_KEY = 'epc_offline_pending';
  const persistenceOn = () => (deps.persistenceOn ? !!deps.persistenceOn() : !!global.EPC_PERSISTENCE_ON);
  const wantPersistence = () => (deps.wantPersistence ? deps.wantPersistence() : (global.EPCReads && global.EPCReads.wantPersistence()));
  function _init(overrides) { deps = { ...deps, ...overrides }; }
  const storage = () => { if (deps.storage) return deps.storage; try { return global.localStorage; } catch (e) { return null; } };
  async function currentUid() {
    if (deps.uid) return deps.uid();
    try { return global.firebase.auth().currentUser ? global.firebase.auth().currentUser.uid : null; } catch (e) { return null; }
  }
  // Stage 1 filled Firebase's local cache on this browser for this user (every
  // list and the chosen days read in full). Pages that read Firebase directly
  // answer from that cache offline, so the switch must not skip the fill
  // until it has happened once per user per browser.
  const PRIMED_KEY = 'epc_fs_primed';
  function markPrimed(uid) { const s = storage(); try { if (s) s.setItem(PRIMED_KEY, String(uid || '')); } catch (e) { /* storage off */ } }
  function isPrimed(uid) { const s = storage(); return !!uid && !!s && s.getItem(PRIMED_KEY) === String(uid); }

  // Browser defaults.
  async function isCompleteDefault() {
    try {
      const uid = await currentUid();
      if (!isPrimed(uid)) return false;
      const days = deps.cachedDates ? await deps.cachedDates('salesDaily') : (global.EPCDays ? await global.EPCDays.cachedDates('salesDaily') : []);
      const meta = deps.meta ? await deps.meta() : (global.EPCSaved && global.EPCSaved.meta ? await global.EPCSaved.meta() : {});
      const mine = (m) => !!m && m.uid === uid;
      return days.length > 0 && mine(meta.purchases) && mine(meta.productMaster);
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

  // Stage 0 (turn Firebase's local storage on, which needs a reload), stage 1
  // (fill if needed), stage 2 (switch). Resolves false when stopped.
  async function switchOn() {
    if (!persistenceOn()) {
      wantPersistence();
      const s = storage();
      try { if (s) s.setItem(PENDING_KEY, '1'); } catch (e) { /* storage off */ }
      reload();                       // continues from start() after the reload
      return true;
    }
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
    if (btn) labelFor(btn);
  }
  let delegated = false;
  function delegateClicks() {
    if (delegated || !global.document) return;
    delegated = true;
    // One listener on the document: the sidebar can be rebuilt (Settings does) and the button with it.
    global.document.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('#epc-offline-btn') : null;
      if (btn) onClick(btn);
    });
    // Another tab switched: follow it.
    global.addEventListener('storage', (ev) => {
      if (ev.key === 'epc_offline' && (ev.newValue === '1') !== isOn()) global.location.reload();
    });
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
    const LIMITED = ' This browser could not keep Firebase’s local storage, so only Reports and the Dashboard have a copy.';
    const text = bar.querySelector('.epc-offline-text');
    text.textContent = BANNER_TEXT + (limited ? LIMITED : '');
    // Persistence settles after load: update the wording when it does.
    if (global.EPC_PERSISTENCE_READY && typeof global.EPC_PERSISTENCE_READY.then === 'function') {
      global.EPC_PERSISTENCE_READY.then((ok) => { text.textContent = BANNER_TEXT + (ok ? '' : LIMITED); });
    }
    bar.querySelector('.epc-offline-back').addEventListener('click', (ev) => onClick(ev.currentTarget));
    doc.body.appendChild(bar);
    doc.body.classList.add('has-offline-banner');
  }
  function continuePending() {
    const s = storage();
    let pending = false;
    try { pending = !!s && s.getItem(PENDING_KEY) === '1'; } catch (e) { pending = false; }
    if (!pending || !persistenceOn() || isOn()) { try { if (s) s.removeItem(PENDING_KEY); } catch (e) { /* ignore */ } return; }
    try { s.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    // Wait for sign-in, then carry on with the fill and the switch.
    const go = () => { const btn = global.document.getElementById('epc-offline-btn'); if (btn) onClick(btn); else switchOn().catch(() => {}); };
    if (global.document.getElementById('sidebar-container') && global.document.getElementById('sidebar-container').dataset.built) go();
    else global.document.addEventListener('epc-auth-ready', go, { once: true });
  }
  function start() {
    delegateClicks();
    wireButton();
    paintBanner();
    continuePending();
    // The sidebar is rendered (and sometimes rebuilt) after load: keep the label right.
    if (global.MutationObserver && global.document.body) {
      new MutationObserver(wireButton).observe(global.document.body, { childList: true, subtree: true });
    }
  }
  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  const api = { BANNER_TEXT, isOn, isComplete, markPrimed, switchOn, switchOff, _init };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.EPCOffline = api;
})(typeof window !== 'undefined' ? window : globalThis);
