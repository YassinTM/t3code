import type { SpeechSynthesizeResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createReadAloudManager, createReadAloudSession, type ReadAloudPlayer } from "./readAloud";
import type { SpeechChunker } from "./speakable";
import type { SpeechPlayerState } from "./speechPlayer";

/** Lets queued microtasks and promise callbacks run before the next assertion. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const resultFor = (text: string): SpeechSynthesizeResult => ({
  sampleRate: 24_000,
  pcm16: `pcm:${text}`,
  durationMs: 10,
});

/** A chunker over `|`-delimited text, so a test decides exactly when a chunk is released. */
function delimitedChunker(): SpeechChunker {
  let markdown = "";
  let emitted = 0;
  return {
    push(next) {
      markdown = next;
      const chunks: string[] = [];
      let index = next.indexOf("|", emitted);
      while (index >= 0) {
        const text = next.slice(emitted, index).trim();
        emitted = index + 1;
        if (text.length > 0) chunks.push(text);
        index = next.indexOf("|", emitted);
      }
      return chunks;
    },
    finish() {
      const text = markdown.slice(emitted).trim();
      emitted = markdown.length;
      return text.length > 0 ? [text] : [];
    },
  };
}

/** Synthesis that only resolves when the test says so, so prefetch is observable. */
function deferredSynthesis() {
  const requested: string[] = [];
  const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const synthesize = (text: string): Promise<SpeechSynthesizeResult> => {
    requested.push(text);
    return new Promise<SpeechSynthesizeResult>((resolve, reject) => {
      pending.push({ resolve: () => resolve(resultFor(text)), reject });
    });
  };
  const settleAll = () => {
    for (const request of pending.splice(0)) request.resolve();
  };
  return { synthesize, requested, pending, settleAll };
}

type FakePlayer = ReadAloudPlayer & {
  readonly enqueued: ReadonlyArray<{ pcm16: string; sampleRate: number }>;
  readonly stops: number;
  /** Pretends the chunk at `index` reached the speakers. */
  play(index: number): void;
  /** Pretends the queue drained on its own. */
  drain(): void;
};

function fakePlayer(): FakePlayer {
  const enqueued: Array<{ pcm16: string; sampleRate: number }> = [];
  const listeners = new Set<(state: SpeechPlayerState) => void>();
  let currentIndex = -1;
  let state: SpeechPlayerState = "idle";
  let stops = 0;
  const notify = () => {
    for (const listener of listeners) listener(state);
  };
  return {
    enqueue(pcm16, sampleRate) {
      enqueued.push({ pcm16, sampleRate });
    },
    stop() {
      stops += 1;
      currentIndex = -1;
      state = "idle";
      notify();
    },
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
    get enqueued() {
      return enqueued;
    },
    get stops() {
      return stops;
    },
    play(index) {
      currentIndex = index;
      state = "playing";
      notify();
    },
    drain() {
      state = "idle";
      notify();
    },
  };
}

describe("createReadAloudSession", () => {
  it("synthesizes and enqueues chunks in order", async () => {
    const player = fakePlayer();
    const synthesis = deferredSynthesis();
    const session = createReadAloudSession({
      synthesize: synthesis.synthesize,
      player,
      onError: () => {},
      createChunker: delimitedChunker,
    });

    session.push("First|Second|Third|");
    await flush();
    expect(synthesis.requested).toEqual(["First", "Second"]);

    synthesis.settleAll();
    await flush();
    expect(player.enqueued.map((chunk) => chunk.pcm16)).toEqual(["pcm:First", "pcm:Second"]);

    player.play(0);
    await flush();
    expect(synthesis.requested).toEqual(["First", "Second", "Third"]);

    synthesis.settleAll();
    await flush();
    session.finish();
    player.play(1);
    player.play(2);
    player.drain();
    await flush();

    expect(player.enqueued.map((chunk) => chunk.pcm16)).toEqual([
      "pcm:First",
      "pcm:Second",
      "pcm:Third",
    ]);
    // Reaching the end is not a stop: the player must not be torn down.
    expect(player.stops).toBe(0);
    expect(session.status).toBe("idle");
  });

  it("keeps at most two chunks synthesized ahead of the one playing", async () => {
    const player = fakePlayer();
    const synthesis = deferredSynthesis();
    const session = createReadAloudSession({
      synthesize: synthesis.synthesize,
      player,
      onError: () => {},
      createChunker: delimitedChunker,
    });

    session.push("A|B|C|D|E|");
    await flush();
    expect(synthesis.requested).toEqual(["A", "B"]);

    synthesis.settleAll();
    await flush();
    player.play(0);
    await flush();
    expect(synthesis.requested).toEqual(["A", "B", "C"]);

    player.play(1);
    await flush();
    expect(synthesis.requested).toEqual(["A", "B", "C", "D"]);

    session.stop();
    expect(player.stops).toBe(1);
  });

  it("ignores synthesis that lands after a stop", async () => {
    const player = fakePlayer();
    const synthesis = deferredSynthesis();
    const onError = vi.fn();
    const session = createReadAloudSession({
      synthesize: synthesis.synthesize,
      player,
      onError,
      createChunker: delimitedChunker,
    });

    session.push("A|B|");
    await flush();
    expect(synthesis.requested).toEqual(["A", "B"]);

    session.stop();
    expect(session.status).toBe("idle");
    synthesis.settleAll();
    await flush();

    expect(player.enqueued).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failed synthesis, stops, and keeps the error", async () => {
    const player = fakePlayer();
    const synthesis = deferredSynthesis();
    const errors: Error[] = [];
    const session = createReadAloudSession({
      synthesize: synthesis.synthesize,
      player,
      onError: (error) => errors.push(error),
      createChunker: delimitedChunker,
    });

    session.push("A|");
    await flush();
    synthesis.pending.splice(0)[0]?.reject(new Error("synthesis blew up"));
    await flush();

    expect(errors.map((error) => error.message)).toEqual(["synthesis blew up"]);
    expect(player.stops).toBe(1);
    expect(player.enqueued).toEqual([]);
    expect(session.status).toBe("idle");
  });

  it("wraps a non-Error rejection in an Error", async () => {
    const player = fakePlayer();
    const synthesis = deferredSynthesis();
    const errors: Error[] = [];
    const session = createReadAloudSession({
      synthesize: synthesis.synthesize,
      player,
      onError: (error) => errors.push(error),
      createChunker: delimitedChunker,
    });

    session.push("A|");
    await flush();
    synthesis.pending.splice(0)[0]?.reject("nope");
    await flush();

    expect(errors.map((error) => error.message)).toEqual(["nope"]);
    expect(session.status).toBe("idle");
  });

  it("speaks only finished sentences while streaming, then releases the tail on finish", async () => {
    const player = fakePlayer();
    const synthesis = deferredSynthesis();
    const session = createReadAloudSession({
      synthesize: synthesis.synthesize,
      player,
      onError: () => {},
    });

    session.push("First sentence is here. Second sentence is here.");
    await flush();
    expect(synthesis.requested).toEqual(["First sentence is here."]);

    synthesis.settleAll();
    await flush();
    session.finish();
    await flush();

    expect(synthesis.requested).toEqual(["First sentence is here.", "Second sentence is here."]);

    synthesis.settleAll();
    await flush();
    expect(player.enqueued.map((chunk) => chunk.pcm16)).toEqual([
      "pcm:First sentence is here.",
      "pcm:Second sentence is here.",
    ]);
  });
});

describe("createReadAloudManager", () => {
  it("stops the message that was reading when another starts", async () => {
    const manager = createReadAloudManager();
    const first = fakePlayer();
    const second = fakePlayer();
    const firstSynthesis = deferredSynthesis();

    manager.start("first", "A|", false, {
      synthesize: firstSynthesis.synthesize,
      player: first,
      onError: () => {},
      createChunker: delimitedChunker,
    });
    await flush();
    expect(manager.status("first")).toBe("starting");

    manager.start("second", "B|", false, {
      synthesize: deferredSynthesis().synthesize,
      player: second,
      onError: () => {},
      createChunker: delimitedChunker,
    });

    expect(first.stops).toBe(1);
    expect(manager.status("first")).toBe("idle");
    expect(manager.status("second")).toBe("starting");
  });

  it("ignores push, finish, and stopKey from a message that does not own the session", async () => {
    const manager = createReadAloudManager();
    const player = fakePlayer();
    const synthesis = deferredSynthesis();

    manager.start("first", "A|", true, {
      synthesize: synthesis.synthesize,
      player,
      onError: () => {},
      createChunker: delimitedChunker,
    });
    await flush();
    expect(synthesis.requested).toEqual(["A"]);

    manager.push("second", "X|Y|");
    manager.finish("second");
    manager.stopKey("second");
    await flush();

    expect(synthesis.requested).toEqual(["A"]);
    expect(player.stops).toBe(0);
    expect(manager.status("first")).toBe("starting");
    expect(manager.status("second")).toBe("idle");
  });

  it("clears the active message once playback drains on its own", async () => {
    const manager = createReadAloudManager();
    const player = fakePlayer();
    const synthesis = deferredSynthesis();

    manager.start("first", "A|", false, {
      synthesize: synthesis.synthesize,
      player,
      onError: () => {},
      createChunker: delimitedChunker,
    });
    await flush();
    synthesis.settleAll();
    await flush();
    expect(player.enqueued).toHaveLength(1);

    player.play(0);
    player.drain();
    await flush();

    expect(manager.status("first")).toBe("idle");
    expect(player.stops).toBe(0);
  });

  it("notifies subscribers as the status changes", async () => {
    const manager = createReadAloudManager();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.start("first", "A|", false, {
      synthesize: deferredSynthesis().synthesize,
      player: fakePlayer(),
      onError: () => {},
      createChunker: delimitedChunker,
    });
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    manager.stop();
    expect(listener).toHaveBeenCalled();
  });
});
