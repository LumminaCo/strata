export type QuerySoundKind = "success" | "error";

export type QueryAudioContext = Pick<
  AudioContext,
  "currentTime" | "state" | "destination" | "resume" | "createOscillator" | "createGain"
>;

interface ToneStep {
  frequency: number;
  overtone?: number;
  offsetSec: number;
  durationSec: number;
  peakGain: number;
  waveform: OscillatorType;
}

const tones: Record<QuerySoundKind, readonly ToneStep[]> = {
  // Bright, warm two-note rising chime (E5 -> B5) with subtle octave shimmer.
  success: [
    {
      frequency: 659.25,
      overtone: 1318.5,
      offsetSec: 0,
      durationSec: 0.24,
      peakGain: 0.16,
      waveform: "sine",
    },
    {
      frequency: 987.77,
      overtone: 1975.53,
      offsetSec: 0.11,
      durationSec: 0.36,
      peakGain: 0.19,
      waveform: "sine",
    },
  ],
  // Distinct, gentle two-note descending alert (A4 -> F4) for failed queries.
  error: [
    {
      frequency: 440,
      offsetSec: 0,
      durationSec: 0.19,
      peakGain: 0.16,
      waveform: "triangle",
    },
    {
      frequency: 349.23,
      offsetSec: 0.13,
      durationSec: 0.3,
      peakGain: 0.17,
      waveform: "triangle",
    },
  ],
};

let sharedContext: QueryAudioContext | null = null;

function createBrowserAudioContext(): QueryAudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    return new AudioCtor();
  } catch {
    return null;
  }
}

function getSharedAudioContext(
  factory: () => QueryAudioContext | null = createBrowserAudioContext,
): QueryAudioContext | null {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = factory();
  }
  return sharedContext;
}

export function resetQuerySoundForTest() {
  sharedContext = null;
}

/**
 * Unlocks or resumes the shared AudioContext during a user gesture (such as clicking Run
 * or pressing Ctrl+Enter) so completion audio plays reliably even after long queries.
 */
export function primeQuerySound(
  factory: () => QueryAudioContext | null = createBrowserAudioContext,
): boolean {
  const ctx = getSharedAudioContext(factory);
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    void Promise.resolve(ctx.resume()).catch(() => {});
  }
  return true;
}

function scheduleOscillator(
  ctx: QueryAudioContext,
  frequency: number,
  waveform: OscillatorType,
  startTime: number,
  durationSec: number,
  peakGain: number,
) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const attackSec = 0.01;
  const endTime = startTime + durationSec;

  oscillator.type = waveform;
  oscillator.frequency.setValueAtTime(frequency, startTime);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + attackSec);
  gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.onended = () => {
    try {
      oscillator.disconnect();
      gain.disconnect();
    } catch {
      /* Nodes may already be disconnected. */
    }
  };

  oscillator.start(startTime);
  oscillator.stop(endTime + 0.02);
}

export function playQuerySound(
  kind: QuerySoundKind = "success",
  factory: () => QueryAudioContext | null = createBrowserAudioContext,
): boolean {
  const ctx = getSharedAudioContext(factory);
  if (!ctx) return false;

  const schedule = () => {
    try {
      const origin = ctx.currentTime + 0.015;
      for (const step of tones[kind]) {
        const start = origin + step.offsetSec;
        scheduleOscillator(
          ctx,
          step.frequency,
          step.waveform,
          start,
          step.durationSec,
          step.peakGain,
        );
        if (step.overtone) {
          scheduleOscillator(
            ctx,
            step.overtone,
            "sine",
            start,
            step.durationSec * 0.72,
            step.peakGain * 0.22,
          );
        }
      }
    } catch {
      /* Ignore audio scheduling failures in restricted environments. */
    }
  };

  if (ctx.state === "suspended") {
    void Promise.resolve(ctx.resume())
      .then(() => {
        if (ctx.state !== "closed") schedule();
      })
      .catch(() => {});
  } else {
    schedule();
  }

  return true;
}
