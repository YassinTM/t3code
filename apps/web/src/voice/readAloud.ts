/**
 * Read-aloud controller: turns a message's Markdown into ordered spoken chunks, synthesizes them
 * on the speech machine no more than two chunks ahead of playback, and hands the audio to the
 * player. One message reads at a time app-wide, so starting another stops the current one.
 *
 * The React wiring lives in `useReadAloud.ts`; this module stays free of React so the ordering,
 * prefetch window, and cancellation rules are unit-testable with fakes.
 */
import type { SpeechSynthesizeResult } from "@t3tools/contracts";

import { createSpeechChunker, type SpeechChunker } from "./speakable";
import type { SpeechPlayerState } from "./speechPlayer";

export type ReadAloudStatus = "idle" | "starting" | "playing";

/** The part of the player the controller drives, so tests can supply a fake. */
export interface ReadAloudPlayer {
  enqueue(pcm16Base64: string, sampleRate: number): void;
  stop(): void;
  readonly currentIndex: number;
  readonly state: SpeechPlayerState;
  onStateChange(listener: (state: SpeechPlayerState) => void): () => void;
}

export interface ReadAloudOptions {
  readonly synthesize: (text: string) => Promise<SpeechSynthesizeResult>;
  readonly player: ReadAloudPlayer;
  readonly onError: (error: Error) => void;
  readonly onComplete?: () => void;
  /** Chunks allowed to be synthesized ahead of the one now playing. */
  readonly prefetch?: number;
  readonly createChunker?: () => SpeechChunker;
}

export interface ReadAloudSession {
  /** Adds the full markdown seen so far; only newly complete chunks are spoken. */
  push(markdown: string): void;
  /** Marks the stream complete and releases the trailing text. */
  finish(): void;
  /** Cancels every pending synthesis and clears the player. */
  stop(): void;
  readonly status: ReadAloudStatus;
  /** Called whenever the status changes (a chunk starts, playback ends, or a stop lands). */
  subscribe(listener: () => void): () => void;
}

type ChunkState = "waiting" | "ready";

interface Chunk {
  readonly text: string;
  state: ChunkState;
  result: SpeechSynthesizeResult | null;
}

const DEFAULT_PREFETCH = 2;

export function createReadAloudSession(options: ReadAloudOptions): ReadAloudSession {
  const prefetch = options.prefetch ?? DEFAULT_PREFETCH;
  const chunker = (options.createChunker ?? createSpeechChunker)();
  const chunks: Chunk[] = [];
  const listeners = new Set<() => void>();
  let nextToSynthesize = 0;
  let nextToEnqueue = 0;
  let finished = false;
  let hasPlayed = false;
  let stopped = false;

  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function status(): ReadAloudStatus {
    if (stopped) return "idle";
    return options.player.state === "playing" ? "playing" : "starting";
  }

  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    unsubscribePlayer();
    emit();
  }

  function complete(): void {
    if (stopped) return;
    shutdown();
    options.onComplete?.();
  }

  function stop(): void {
    if (stopped) return;
    shutdown();
    options.player.stop();
  }

  function fail(error: unknown): void {
    stop();
    options.onError(error instanceof Error ? error : new Error(String(error)));
  }

  function requestChunk(index: number): void {
    const chunk = chunks[index]!;
    Promise.resolve()
      .then(() => options.synthesize(chunk.text))
      .then(
        (result) => {
          if (stopped) return;
          chunk.state = "ready";
          chunk.result = result;
          pump();
        },
        (error: unknown) => {
          if (stopped) return;
          fail(error);
        },
      );
  }

  function maybeComplete(): void {
    if (stopped || !finished) return;
    if (nextToSynthesize < chunks.length || nextToEnqueue < chunks.length) return;
    if (chunks.length === 0 || (hasPlayed && options.player.state === "idle")) {
      complete();
    }
  }

  function pump(): void {
    if (stopped) return;
    const playing = options.player.currentIndex;
    // Keep at most `prefetch` chunks synthesized beyond the one now playing; with nothing
    // playing yet (`-1`) that admits the first `prefetch` chunks and no more.
    while (nextToSynthesize < chunks.length && nextToSynthesize <= playing + prefetch) {
      const index = nextToSynthesize;
      nextToSynthesize += 1;
      requestChunk(index);
    }
    while (nextToEnqueue < chunks.length && chunks[nextToEnqueue]!.state === "ready") {
      const chunk = chunks[nextToEnqueue]!;
      options.player.enqueue(chunk.result!.pcm16, chunk.result!.sampleRate);
      nextToEnqueue += 1;
    }
    emit();
    maybeComplete();
  }

  const unsubscribePlayer = options.player.onStateChange((state) => {
    if (state === "playing") hasPlayed = true;
    pump();
  });

  function pushMarkdown(markdown: string): void {
    if (stopped || finished) return;
    const released = chunker.push(markdown);
    if (released.length === 0) return;
    for (const text of released) {
      chunks.push({ text, state: "waiting", result: null });
    }
    pump();
  }

  function finish(): void {
    if (stopped || finished) return;
    const released = chunker.finish();
    for (const text of released) {
      chunks.push({ text, state: "waiting", result: null });
    }
    finished = true;
    pump();
  }

  return {
    push: pushMarkdown,
    finish,
    stop,
    get status() {
      return status();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface ReadAloudManager {
  /** Starts reading `key`, stopping whatever was reading before. */
  start(key: string, markdown: string, streaming: boolean, options: ReadAloudOptions): void;
  /** Feeds growing markdown to the active session, if it belongs to `key`. */
  push(key: string, markdown: string): void;
  /** Ends the active session's stream, if it belongs to `key`. */
  finish(key: string): void;
  /** Stops the active session, if it belongs to `key`. */
  stopKey(key: string): void;
  /** Stops whatever is reading. */
  stop(): void;
  /** The active session's status for `key`, or `idle` when another message (or nothing) reads. */
  status(key: string): ReadAloudStatus;
  subscribe(listener: () => void): () => void;
}

/**
 * App-wide coordinator: at most one message speaks, so `start` stops the previous session and a
 * stale `push`/`finish`/`stopKey` from another row is ignored.
 */
export function createReadAloudManager(): ReadAloudManager {
  let activeKey: string | null = null;
  let session: ReadAloudSession | null = null;
  let unsubscribeSession: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function clear(): void {
    unsubscribeSession?.();
    unsubscribeSession = null;
    session = null;
    activeKey = null;
  }

  function stop(): void {
    const current = session;
    clear();
    current?.stop();
    emit();
  }

  function start(
    key: string,
    markdown: string,
    streaming: boolean,
    options: ReadAloudOptions,
  ): void {
    stop();
    const next = createReadAloudSession({
      ...options,
      onComplete: () => {
        clear();
        options.onComplete?.();
        emit();
      },
    });
    activeKey = key;
    session = next;
    unsubscribeSession = next.subscribe(emit);
    next.push(markdown);
    if (!streaming) {
      next.finish();
    }
    emit();
  }

  function push(key: string, markdown: string): void {
    if (session !== null && activeKey === key) session.push(markdown);
  }

  function finish(key: string): void {
    if (session !== null && activeKey === key) session.finish();
  }

  function stopKey(key: string): void {
    if (session !== null && activeKey === key) stop();
  }

  function status(key: string): ReadAloudStatus {
    return session !== null && activeKey === key ? session.status : "idle";
  }

  return {
    start,
    push,
    finish,
    stopKey,
    stop,
    status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The one coordinator the app reads through. */
export const readAloudManager = createReadAloudManager();
