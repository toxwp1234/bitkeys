export const dopamine = (() => {
  const config = {
    anticipationMs: 240,
    revealDuration: 150,
    pulseScale: 1.18,
    soundPitch: 0.5,
  };

  function getEntropy(balanceSats) {
    if (balanceSats === 0) return 0.3;
    if (balanceSats > 1e7) return 0.95;
    const log = Math.log10(balanceSats);
    return Math.max(0.3, Math.min(0.95, (log / 8) * 1.2));
  }

  function playFeedback(balanceSats) {
    if (!window.audioCtx) {
      window.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = window.audioCtx;
    // The context is created in a "suspended" state until a user gesture; the
    // balance reveal fires after an async fetch (outside the click), so resume
    // it here or the tone stays silent.
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const entropy = getEntropy(balanceSats);
    const freq = 400 + entropy * 600;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  function reveal(element, balanceSats) {
    const entropy = getEntropy(balanceSats);

    element.style.opacity = "0.15";
    element.style.transform = "scale(0.65)";

    return new Promise((resolve) => {
      setTimeout(() => {
        element.style.transition = `all ${config.revealDuration}ms cubic-bezier(0.68, -0.55, 0.265, 1.55)`;
        element.style.opacity = "1";
        element.style.transform = `scale(${1 + entropy * (config.pulseScale - 1)})`;

        playFeedback(balanceSats);

        setTimeout(() => {
          element.style.transition = "transform 0.3s ease-out";
          element.style.transform = "scale(1)";
          resolve();
        }, config.revealDuration);
      }, config.anticipationMs);
    });
  }

  return { reveal, getEntropy, playFeedback, config };
})();
