let sharedCtx = null;

async function getAudioContext() {
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === "suspended") {
    await sharedCtx.resume();
  }
  return sharedCtx;
}

export async function playConnectedSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.value = 523.25; // C5
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc1.connect(gain1).connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.value = 659.25; // E5
    gain2.gain.setValueAtTime(0.001, now);
    gain2.gain.setValueAtTime(0.15, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.25);
  } catch {
    // audio not available
  }
}

export async function playDisconnectedSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.value = 659.25; // E5
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc1.connect(gain1).connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.value = 523.25; // C5
    gain2.gain.setValueAtTime(0.001, now);
    gain2.gain.setValueAtTime(0.15, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.25);
  } catch {
    // audio not available
  }
}

export async function playUserJoinedSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 659.25; // E5
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  } catch {
    // audio not available
  }
}

export async function playUserLeftSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 523.25; // C5
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  } catch {
    // audio not available
  }
}

export async function playMuteSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 392.0; // G4
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  } catch {
    // audio not available
  }
}

export async function playUnmuteSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440.0; // A4
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  } catch {
    // audio not available
  }
}

export async function playDeafenSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.value = 392.0; // G4
    gain1.gain.setValueAtTime(0.1, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc1.connect(gain1).connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.07);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.value = 293.66; // D4
    gain2.gain.setValueAtTime(0.001, now);
    gain2.gain.setValueAtTime(0.1, now + 0.07);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(now + 0.07);
    osc2.stop(now + 0.14);
  } catch {
    // audio not available
  }
}

export async function playUndeafenSound() {
  try {
    const ctx = await getAudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.value = 293.66; // D4
    gain1.gain.setValueAtTime(0.1, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc1.connect(gain1).connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.07);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.value = 392.0; // G4
    gain2.gain.setValueAtTime(0.001, now);
    gain2.gain.setValueAtTime(0.1, now + 0.07);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(now + 0.07);
    osc2.stop(now + 0.14);
  } catch {
    // audio not available
  }
}

export function schedulePlaybackResume(element, pendingPlaybackElements) {
  if (
    !element ||
    typeof document === "undefined" ||
    pendingPlaybackElements.has(element)
  ) {
    return;
  }

  pendingPlaybackElements.add(element);

  const resume = () => {
    try {
      element.play?.();
    } catch {
      // ignore subsequent failures
    }

    document.removeEventListener("pointerdown", resume);
    document.removeEventListener("keydown", resume);
    pendingPlaybackElements.delete(element);
  };

  document.addEventListener("pointerdown", resume, { once: true });
  document.addEventListener("keydown", resume, { once: true });
}
