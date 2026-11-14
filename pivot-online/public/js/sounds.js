// public/js/sounds.js — Sons générés via Web Audio API (aucun fichier externe requis).
//
// Sons disponibles (PIVOT.sounds.play('name')):
//   click    — petit clic d'interface
//   move     — glissement du pivot (swoosh)
//   borne    — pose d'une borne (thud)
//   virage   — virage (swoosh plus grave)
//   diagonale — diagonale (swoosh montant)
//   tp       — téléportation (zap / bulle)
//   win      — victoire (fanfare courte)
//   lose     — défaite (descendante triste)
//   rankup   — montée de rank (fanfare triomphante)
//   chest    — ouverture de coffre (clinking)
//   error    — erreur (buzz court)
//   join     — entrée dans la file (notification)
//   quit     — abandon

(function() {
  let ctx = null;
  let enabled = true;

  // Chargement de la préférence utilisateur
  try { enabled = localStorage.getItem('pivot_sound_enabled') !== '0'; } catch (e) {}

  function getCtx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    // Reprise du contexte (les navigateurs bloquent l'audio avant interaction)
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Joue une tonalité simple
  function tone(freq, duration, type, when, gain) {
    type = type || 'sine';
    when = when || 0;
    gain = gain || 0.15;
    const c = getCtx();
    if (!c) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  // Glissé fréquentiel
  function slide(f0, f1, duration, type, when, gain) {
    type = type || 'sine';
    when = when || 0;
    gain = gain || 0.15;
    const c = getCtx();
    if (!c) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + duration);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  // Bruit court (pour le thud de borne)
  function noise(duration, when, gain, filterFreq) {
    const c = getCtx();
    if (!c) return;
    when = when || 0;
    gain = gain || 0.2;
    filterFreq = filterFreq || 200;
    const t0 = c.currentTime + when;
    const bufferSize = Math.floor(c.sampleRate * duration);
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = c.createBufferSource();
    src.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + duration + 0.05);
  }

  const SOUNDS = {
    click: () => { tone(660, 0.08, 'square', 0, 0.08); },
    move:  () => { slide(220, 440, 0.18, 'sine', 0, 0.12); },
    borne: () => { noise(0.18, 0, 0.25, 220); tone(140, 0.12, 'sine', 0, 0.15); },
    virage:() => { slide(440, 220, 0.22, 'triangle', 0, 0.12); },
    diagonale: () => { slide(330, 660, 0.2, 'sawtooth', 0, 0.08); },
    tp:    () => {
      slide(880, 220, 0.15, 'sine', 0, 0.12);
      slide(220, 880, 0.15, 'sine', 0.16, 0.1);
    },
    win:   () => {
      tone(523, 0.12, 'triangle', 0, 0.18);
      tone(659, 0.12, 'triangle', 0.13, 0.18);
      tone(784, 0.18, 'triangle', 0.26, 0.2);
      tone(1046, 0.3, 'triangle', 0.46, 0.22);
    },
    lose:  () => {
      tone(440, 0.18, 'triangle', 0, 0.18);
      tone(330, 0.2, 'triangle', 0.18, 0.18);
      tone(220, 0.3, 'triangle', 0.36, 0.18);
    },
    rankup:() => {
      tone(523, 0.1, 'square', 0, 0.12);
      tone(659, 0.1, 'square', 0.1, 0.12);
      tone(784, 0.1, 'square', 0.2, 0.12);
      tone(1046, 0.1, 'square', 0.3, 0.14);
      tone(1318, 0.25, 'square', 0.4, 0.16);
    },
    chest: () => {
      tone(880, 0.05, 'sine', 0, 0.1);
      tone(1100, 0.05, 'sine', 0.06, 0.1);
      tone(1320, 0.08, 'sine', 0.12, 0.12);
      noise(0.1, 0.18, 0.1, 800);
      tone(1568, 0.2, 'triangle', 0.25, 0.14);
    },
    error: () => { tone(150, 0.18, 'sawtooth', 0, 0.12); },
    join:  () => { tone(660, 0.1, 'sine', 0, 0.12); tone(880, 0.15, 'sine', 0.1, 0.12); },
    quit:  () => { slide(440, 110, 0.4, 'sawtooth', 0, 0.15); }
  };

  window.PIVOT = window.PIVOT || {};
  PIVOT.sounds = {
    play: function(name) {
      if (!enabled) return;
      const fn = SOUNDS[name];
      if (fn) try { fn(); } catch (e) { /* silencieux */ }
    },
    setEnabled: function(v) { enabled = !!v; try { localStorage.setItem('pivot_sound_enabled', enabled ? '1' : '0'); } catch (e) {} },
    isEnabled: function() { return enabled; },
    // Active l'audio après un clic utilisateur (les navigateurs l'exigent)
    unlock: function() { getCtx(); }
  };
})();
