/**
 * WebAudio playback for spoken chunks. The environment returns 16-bit mono PCM; the player
 * decodes it, schedules every chunk on one context so playback is gapless, and reports which
 * chunk is playing so the read-aloud controller can keep its prefetch window small.
 */

export type SpeechPlayerState = "idle" | "playing";

/** Decodes base64 little-endian int16 mono PCM into floats scaled by 1/32768. */
export function pcm16Base64ToFloat32(pcm16Base64: string): Float32Array {
  const binary = atob(pcm16Base64);
  const sampleCount = binary.length >> 1;
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const value = (high << 8) | low;
    samples[index] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
  }
  return samples;
}

export interface SpeechPlayer {
  /** Decodes and schedules one chunk after whatever is already queued. */
  enqueue(pcm16Base64: string, sampleRate: number): void;
  /** Stops every scheduled chunk immediately and clears the queue. */
  stop(): void;
  /** Creates or resumes the audio context inside a user gesture, before the first awaited chunk. */
  prime(): void;
  /** Index of the chunk now playing, or -1 when nothing is playing. */
  readonly currentIndex: number;
  readonly state: SpeechPlayerState;
  /** Called whenever the playing chunk or the idle/playing state changes. */
  onStateChange(listener: (state: SpeechPlayerState) => void): () => void;
}

/**
 * Browsers only let an `AudioContext` start from a user gesture, so the context is created on
 * the click (`prime`) or lazily on the first `enqueue`, and every chunk shares its clock.
 */
export function createSpeechPlayer(): SpeechPlayer {
  let context: AudioContext | null = null;
  let nextStartTime = 0;
  let currentIndex = -1;
  let state: SpeechPlayerState = "idle";
  let enqueued = 0;
  const sources = new Map<AudioBufferSourceNode, () => void>();
  const startTimers = new Set<ReturnType<typeof setTimeout>>();
  const listeners = new Set<(state: SpeechPlayerState) => void>();

  function notify(): void {
    for (const listener of listeners) {
      listener(state);
    }
  }

  function setState(next: SpeechPlayerState): void {
    if (state === next) return;
    state = next;
    notify();
  }

  function setCurrentIndex(index: number): void {
    if (currentIndex === index) return;
    currentIndex = index;
    notify();
  }

  function ensureContext(): AudioContext | null {
    if (context !== null) return context;
    if (typeof AudioContext === "undefined") return null;
    context = new AudioContext();
    return context;
  }

  function prime(): void {
    const ctx = ensureContext();
    if (ctx !== null && ctx.state === "suspended") {
      void ctx.resume();
    }
  }

  function enqueue(pcm16Base64: string, sampleRate: number): void {
    const ctx = ensureContext();
    if (ctx === null) return;
    const samples = pcm16Base64ToFloat32(pcm16Base64);
    if (samples.length === 0) return;
    const index = enqueued;
    enqueued += 1;
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextStartTime);
    nextStartTime = startAt + buffer.duration;
    const handleEnded = () => {
      sources.delete(source);
      // Sources overlap gaplessly, so the queue is only empty once the last one ends.
      if (sources.size === 0) {
        setState("idle");
      }
    };
    source.addEventListener("ended", handleEnded);
    sources.set(source, handleEnded);
    source.start(startAt);
    const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
    const handle = setTimeout(() => {
      startTimers.delete(handle);
      setCurrentIndex(index);
      setState("playing");
    }, delayMs);
    startTimers.add(handle);
  }

  function stop(): void {
    for (const timer of startTimers) {
      clearTimeout(timer);
    }
    startTimers.clear();
    for (const [source, handleEnded] of sources) {
      source.removeEventListener("ended", handleEnded);
      try {
        source.stop();
      } catch {
        // A source that never reached the clock throws on stop; there is nothing to cancel.
      }
      source.disconnect();
    }
    sources.clear();
    nextStartTime = 0;
    enqueued = 0;
    setCurrentIndex(-1);
    setState("idle");
  }

  return {
    enqueue,
    stop,
    prime,
    get currentIndex() {
      return currentIndex;
    },
    get state() {
      return state;
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
