// ─── Season theme, logo intro and sounds ─────────────────────────────────────
// The season is picked from today's date by a small script in the page head
// (window.EPC_SEASON, <html data-season>). Add ?season=christmas (or newyear,
// valentine, summer, rainy, default) to the address to preview another one.
//   • banner   – warm gradient hero, string lights (Christmas), drifting particles
//   • intro    – the EPC logo entrance, once per browser session, click to skip
//   • sound    – a short bell tune made with Web Audio (no audio files). Browsers
//                only allow sound after the user has clicked on the site, so when
//                it is blocked the tune plays from the Sound button instead.
(function initSeason() {
  const html = document.documentElement;
  const season = window.EPC_SEASON || 'default';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SEASONS = {
    christmas: { chip: 'Christmas season', tag: 'Maligayang Pasko!', fx: 'snow' },
    newyear:   { chip: 'New Year',         tag: 'Happy New Year!',   fx: 'sparkle' },
    valentine: { chip: "Valentine's",      tag: 'Happy Hearts Day!', fx: 'heart' },
    summer:    { chip: 'Summer season',    tag: 'Accounting Portal', fx: 'sparkle' },
    rainy:     { chip: 'Rainy season',     tag: 'Accounting Portal', fx: 'rain' },
    default:   { chip: '',                 tag: 'Accounting Portal', fx: '' },
  };
  const S = SEASONS[season] || SEASONS.default;
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage off */ } },
  };

  // The date line above the greeting is painted by dashboard.js (the day under review).

  // ── Particles (snow, sparkles, hearts, rain) on a canvas ────────────────────
  function startParticles(canvas, kind, density) {
    if (!canvas || !kind || reduced) return () => {};
    const ctx = canvas.getContext('2d');
    let w = 0; let h = 0; let raf = 0; let parts = [];
    const rand = (a, b) => a + Math.random() * (b - a);
    const make = (anywhere) => ({
      x: rand(0, w), y: anywhere ? rand(0, h) : -10,
      r: kind === 'heart' ? rand(5, 10) : kind === 'rain' ? rand(8, 16) : rand(1.2, 3.4),
      vy: kind === 'rain' ? rand(5, 8) : kind === 'sparkle' ? rand(0.1, 0.35) : rand(0.35, 1.1),
      sway: rand(0, Math.PI * 2), a: rand(0.35, 0.9),
    });
    function size() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      canvas.width = Math.max(1, w * dpr); canvas.height = Math.max(1, h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      parts = Array.from({ length: Math.round((w * h) / 12000 * density) }, () => make(true));
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      parts.forEach((p, i) => {
        p.y += p.vy; p.sway += 0.02;
        if (kind !== 'rain') p.x += Math.sin(p.sway) * 0.4;
        if (p.y > h + 12) parts[i] = make(false);
        if (kind === 'rain') {
          ctx.strokeStyle = `rgba(255,255,255,${p.a * 0.45})`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 2, p.y + p.r); ctx.stroke();
        } else if (kind === 'heart') {
          ctx.fillStyle = `rgba(255,214,222,${p.a * 0.7})`;
          const s = p.r / 10;
          ctx.beginPath(); ctx.moveTo(p.x, p.y + 3 * s);
          ctx.bezierCurveTo(p.x - 10 * s, p.y - 5 * s, p.x - 4 * s, p.y - 11 * s, p.x, p.y - 5 * s);
          ctx.bezierCurveTo(p.x + 4 * s, p.y - 11 * s, p.x + 10 * s, p.y - 5 * s, p.x, p.y + 3 * s);
          ctx.fill();
        } else {
          const glow = kind === 'sparkle' ? (0.5 + 0.5 * Math.sin(p.sway * 3)) : 1;
          ctx.fillStyle = kind === 'sparkle' ? `rgba(255,226,150,${p.a * glow})` : `rgba(255,255,255,${p.a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        }
      });
      raf = requestAnimationFrame(draw);
    }
    size();
    window.addEventListener('resize', size);
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
  }

  // ── Sound: soft bells with Web Audio ────────────────────────────────────────
  const N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5 };
  // [note, beats]. Christmas plays the opening of Jingle Bells.
  const TUNES = {
    christmas: [['E5', 1], ['E5', 1], ['E5', 2], ['E5', 1], ['E5', 1], ['E5', 2], ['E5', 1], ['G5', 1], ['C5', 1], ['D5', 1], ['E5', 3]],
    newyear:   [['C5', 1], ['E5', 1], ['G5', 1], ['C6', 1], ['G5', 1], ['C6', 3]],
    valentine: [['E5', 2], ['G5', 2], ['C6', 3]],
    default:   [['C5', 1], ['E5', 1], ['G5', 1], ['C6', 3]],
  };
  let audio = null;
  let soundOn = store.get('epc_sound', '1') === '1';
  function getAudio() {
    if (audio) return audio;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { audio = new Ctx(); } catch (e) { audio = null; }
    return audio;
  }
  function bell(ctx, out, freq, at, length) {
    [[1, 1], [2, 0.32], [3.01, 0.12]].forEach(([mult, level]) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq * mult;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(level, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      osc.connect(gain); gain.connect(out);
      osc.start(at); osc.stop(at + length + 0.05);
    });
  }
  // Plays the season's tune. Returns false when the browser is still blocking sound.
  async function playTune() {
    const ctx = getAudio();
    if (!ctx) return false;
    try { await ctx.resume(); } catch (e) { /* still blocked */ }
    if (ctx.state !== 'running') return false;
    const out = ctx.createGain();
    out.gain.value = 0.11;                      // deliberately quiet
    out.connect(ctx.destination);
    const beat = 0.17;
    let at = ctx.currentTime + 0.05;
    (TUNES[season] || TUNES.default).forEach(([note, beats]) => { bell(ctx, out, N[note], at, Math.max(0.5, beats * beat * 2.4)); at += beats * beat; });
    return true;
  }

  // ── Banner: chip, effect and sound buttons, lights, particles ───────────────
  const ICON_FX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>';
  const ICON_SOUND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
  const ICON_MUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 6M21 9l-5 6"/></svg>';
  const hero = document.querySelector('.dash-hero');
  const chip = document.getElementById('season-chip');
  const fxBtn = document.getElementById('season-fx-btn');
  const soundBtn = document.getElementById('season-sound-btn');
  let stopBannerFx = () => {};

  function applyFx(on) {
    html.dataset.fx = on ? 'on' : 'off';
    if (fxBtn) { fxBtn.setAttribute('aria-pressed', String(on)); fxBtn.innerHTML = `${ICON_FX} Effects ${on ? 'on' : 'off'}`; }
    stopBannerFx(); stopBannerFx = () => {};
    if (on && hero && S.fx) stopBannerFx = startParticles(hero.querySelector('.season-fx'), S.fx, 1);
  }
  function paintSound() {
    if (!soundBtn) return;
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.innerHTML = `${soundOn ? ICON_SOUND : ICON_MUTE} Sound ${soundOn ? 'on' : 'off'}`;
    soundBtn.title = soundOn ? 'Click to turn the sound off' : 'Click to turn the sound on and hear the tune';
  }

  if (season !== 'default' && hero) {
    if (chip) { chip.textContent = S.chip; chip.hidden = false; }
    if (S.fx) hero.insertAdjacentHTML('afterbegin', '<canvas class="season-fx" aria-hidden="true"></canvas>');
    if (season === 'christmas') hero.insertAdjacentHTML('afterbegin', `<div class="season-lights" aria-hidden="true">${Array.from({ length: 22 }, (_, i) => `<i style="--dl:${(i % 5) * 0.37}s"></i>`).join('')}</div>`);
    if (fxBtn) {
      fxBtn.hidden = false;
      fxBtn.addEventListener('click', () => { const on = html.dataset.fx === 'off'; store.set('epc_fx', on ? '1' : '0'); applyFx(on); });
    }
    applyFx(store.get('epc_fx', '1') === '1');
  }
  if (soundBtn) {
    paintSound();
    soundBtn.addEventListener('click', () => {
      soundOn = !soundOn; store.set('epc_sound', soundOn ? '1' : '0'); paintSound();
      if (soundOn) playTune();
    });
  }

  // ── Logo intro ──────────────────────────────────────────────────────────────
  const intro = document.getElementById('epc-intro');
  if (!intro || !html.classList.contains('intro-pending')) return;
  const tag = document.getElementById('intro-tag');
  if (tag) tag.textContent = S.tag;
  const stopIntroFx = startParticles(intro.querySelector('.intro-fx'), S.fx, 0.8);
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    try { sessionStorage.setItem('epc_intro_seen', '1'); } catch (e) { /* storage off */ }
    intro.classList.add('intro-out');
    document.removeEventListener('keydown', finish);
    setTimeout(() => { stopIntroFx(); html.classList.remove('intro-pending'); intro.remove(); }, 750);
  }
  intro.addEventListener('click', finish);
  document.addEventListener('keydown', finish);
  setTimeout(finish, 3200);
  if (soundOn) {
    playTune().then((played) => {
      if (played) return;
      // Blocked until the first click: play it then, if that comes within a few seconds.
      const onFirstClick = (ev) => {
        document.removeEventListener('pointerdown', onFirstClick, true);
        if (soundOn && !(ev.target.closest && ev.target.closest('#season-sound-btn'))) playTune();
      };
      document.addEventListener('pointerdown', onFirstClick, true);
      setTimeout(() => document.removeEventListener('pointerdown', onFirstClick, true), 8000);
    });
  }
})();
