// Tests for assets/offline.js (EPCOffline): the site-wide Offline mode switch.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const EPCOffline = require('../assets/offline.js');

function setup({ complete, fillResult = true }) {
  const log = [];
  EPCOffline._init({
    isComplete: async () => complete,
    fill: async () => { log.push('fill'); return fillResult; },
    setFlag: (on) => log.push(`flag:${on}`),
    reload: () => log.push('reload'),
    persistenceOn: () => true,          // Firebase's local storage already on (stage 0 done)
    wantPersistence: () => log.push('want'),
  });
  return log;
}

test('switchOn runs the fill first and stops on cancel', async () => {
  const log = setup({ complete: false, fillResult: false });
  assert.equal(await EPCOffline.switchOn(), false);
  assert.deepEqual(log, ['fill']);                      // no flag, no reload
});

test('switchOn fills, then switches, when the copy is not complete', async () => {
  const log = setup({ complete: false, fillResult: true });
  assert.equal(await EPCOffline.switchOn(), true);
  assert.deepEqual(log, ['fill', 'flag:true', 'reload']);
});

test('switchOn skips the fill when the copy is complete', async () => {
  const log = setup({ complete: true });
  assert.equal(await EPCOffline.switchOn(), true);
  assert.deepEqual(log, ['flag:true', 'reload']);
});

test('switchOff clears the flag and reloads', async () => {
  const log = setup({ complete: true });
  await EPCOffline.switchOff();
  assert.deepEqual(log, ['flag:false', 'reload']);
});

test('the banner text is exactly the agreed wording', () => {
  assert.equal(EPCOffline.BANNER_TEXT, 'Offline mode: reading the copy saved on this browser, 0 database reads. Days or records not saved here are missing.');
});

test('copy is complete only when this browser primed Firebase\'s cache for this user', async () => {
  const mem = new Map();
  EPCOffline._init({
    isComplete: null,
    uid: async () => 'me',
    cachedDates: async () => ['2026-11-01'],
    meta: async () => ({ purchases: { uid: 'me' }, productMaster: { uid: 'me' } }),
    storage: { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) },
  });
  assert.equal(await EPCOffline.isComplete(), false);   // never primed
  EPCOffline.markPrimed('me');
  assert.equal(await EPCOffline.isComplete(), true);
  EPCOffline._init({ uid: null, cachedDates: null, meta: null, storage: null });
});

test('switchOn first turns Firebase local storage on and reloads when it is not on yet', async () => {
  const log = [];
  EPCOffline._init({
    isComplete: async () => true, fill: async () => true,
    setFlag: (on) => log.push(`flag:${on}`), reload: () => log.push('reload'),
    persistenceOn: () => false, wantPersistence: () => log.push('want'),
  });
  assert.equal(await EPCOffline.switchOn(), true);
  assert.deepEqual(log, ['want', 'reload']);            // no flag yet: continues after the reload
  EPCOffline._init({ persistenceOn: null, wantPersistence: null });
});

test('switchOn continues normally once Firebase local storage is on', async () => {
  const log = [];
  EPCOffline._init({
    isComplete: async () => true, fill: async () => true,
    setFlag: (on) => log.push(`flag:${on}`), reload: () => log.push('reload'),
    persistenceOn: () => true, wantPersistence: () => log.push('want'),
  });
  assert.equal(await EPCOffline.switchOn(), true);
  assert.deepEqual(log, ['flag:true', 'reload']);
  EPCOffline._init({ persistenceOn: null, wantPersistence: null });
});
