export const dopamine = (() => {
  let audioCtx = null;
  const freqMap = { low: 320, mid: 480, high: 620, max: 800 };

  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function getValueTier(sats) {
    if (sats === 0) return { tier: "empty", entropy: 0.2, freq: freqMap.low, color: "#666" };
    if (sats < 1000) return { tier: "dust", entropy: 0.35, freq: freqMap.low, color: "#999" };
    if (sats < 1e6) return { tier: "small", entropy: 0.55, freq: freqMap.mid, color: "#4a9" };
    if (sats < 1e7) return { tier: "medium", entropy: 0.75, freq: freqMap.high, color: "#4f2" };
    return { tier: "jackpot", entropy: 0.95, freq: freqMap.max, color: "#fff" };
  }

  function harmonic(baseFreq, count) {
    const ctx = initAudio();
    const now = ctx.currentTime;
    const gap = 0.04;

    for (let i = 0; i < count; i++) {
      const t = now + i * gap;
      const freq = baseFreq * (1 + i * 0.15);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.frequency.value = freq;
      osc.type = "sine";
      osc.connect(gain);
      gain.connect(ctx.destination);

      gain.gain.setValueAtTime(0.06 / count, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

      osc.start(t);
      osc.stop(t + 0.08);
    }
  }

  function playFeedback(sats) {
    const { freq, entropy, tier } = getValueTier(sats);
    const harmonics = Math.max(1, Math.min(3, Math.floor(entropy * 4)));   // empty (0) still resolves with a soft tone
    harmonic(freq, harmonics);
  }

  // short rising "pluck" for each potential key as it's checked — pitch climbs with progress
  // so a batch of candidates plays as a satisfying ascending run instead of dead silence.
  function tick(progress) {
    const ctx = initAudio();
    if (ctx.state !== "running") return;
    const p = Math.max(0, Math.min(1, progress || 0));
    const now = ctx.currentTime;
    const base = 360 + p * 560;                 // 360Hz -> ~920Hz across the batch
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(base * 1.5, now + 0.09);   // tiny upward chirp
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    osc.start(now); osc.stop(now + 0.14);
  }

  // ascending major arpeggio when a whole batch of candidates finishes verifying — the "done!" hit
  function chime() {
    const ctx = initAudio();
    if (ctx.state !== "running") return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {   // C5 E5 G5 C6
      const t = now + i * 0.085;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.075, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.start(t); osc.stop(t + 0.3);
    });
  }

  function reveal(element, sats) {
    const data = getValueTier(sats);
    const pulseMax = 1 + data.entropy * 0.25;

    element.style.opacity = "0.05";
    element.style.transform = "scale(0.55) rotateZ(-2deg)";
    element.style.filter = "blur(3px)";

    return new Promise((resolve) => {
      setTimeout(() => {
        element.style.transition = `all 180ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
        element.style.opacity = "1";
        element.style.transform = `scale(${pulseMax}) rotateZ(0deg)`;
        element.style.filter = "blur(0px)";
        element.style.textShadow = `0 0 ${8 + data.entropy * 16}px ${data.color}80`;

        playFeedback(sats);

        setTimeout(() => {
          element.style.transition = "transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94), text-shadow 0.4s ease-out";
          element.style.transform = "scale(1) rotateZ(0deg)";
          element.style.textShadow = "0 0 0px transparent";
          resolve();
        }, 180);
      }, 200);
    });
  }

  return { reveal, getValueTier, playFeedback, initAudio, tick, chime };
})();
