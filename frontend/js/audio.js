// ══════════════════════════════════════════════════════════════
// EcoNav — Synthesized Web Audio Chimes
// Pure Web Audio API — Zero external mp3/wav files needed!
// Upgraded by Member 1 (Hours 04–06)
// ══════════════════════════════════════════════════════════════

const AudioEngine = (() => {
  let _ctx = null;
  let _muted = false;

  function _getContext() {
    if (!_ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) _ctx = new AudioCtx();
    }
    if (_ctx && _ctx.state === 'suspended') {
      _ctx.resume();
    }
    return _ctx;
  }

  // ── Pleasant Two-Tone Turn Chime (D5 -> A5) ──
  function playTurnChime() {
    if (_muted) return;
    try {
      const ctx = _getContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      // Note 1: 587.33 Hz (D5)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.18, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.18);

      // Note 2: 880 Hz (A5)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880.0, now + 0.12);
      gain2.gain.setValueAtTime(0.22, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.40);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.40);
    } catch (_) {}
  }

  // ── Warning Chime for High-Pollution Hotspots ──
  function playWarningChime() {
    if (_muted) return;
    try {
      const ctx = _getContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      // Descending warning tone: 440 Hz -> 330 Hz
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.linearRampToValueAtTime(330, now + 0.28);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch (_) {}
  }

  // ── Celebratory Arrival Chime (Major Chord Arpeggio) ──
  function playArrivalChime() {
    if (_muted) return;
    try {
      const ctx = _getContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6

      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = now + (idx * 0.1);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.20, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.45);
      });
    } catch (_) {}
  }

  function setMuted(val) {
    _muted = val;
  }

  return {
    playTurnChime,
    playWarningChime,
    playArrivalChime,
    setMuted
  };
})();
