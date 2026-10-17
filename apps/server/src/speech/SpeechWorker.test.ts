// @effect-diagnostics nodeBuiltinImport:off -- The suite spawns a real worker fixture and inspects the pid and signal files it writes.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as SpeechWorker from "./SpeechWorker.ts";

const fixtureScript = NodePath.join(import.meta.dirname, "__fixtures__", "fakeSpeechWorker.mjs");

interface Fixture {
  readonly directory: string;
  /** Pid of every worker this fixture spawned, in spawn order. */
  readonly spawns: () => ReadonlyArray<number>;
  readonly signals: () => ReadonlyArray<string>;
}

const makeFixture = (): Fixture => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-speech-worker-"));
  const read = (name: string) => {
    const file = NodePath.join(directory, name);
    if (!NodeFS.existsSync(file)) return [];
    return NodeFS.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  };
  return {
    directory,
    spawns: () => read("spawns.log").map(Number),
    signals: () => read("signals.log"),
  };
};

const cleanup = (fixture: Fixture) =>
  Effect.sync(() => NodeFS.rmSync(fixture.directory, { recursive: true, force: true }));

const testLayer = (fixture: Fixture, timeouts?: SpeechWorker.SpeechWorkerOptions["timeouts"]) =>
  SpeechWorker.layerWith({
    spawn: {
      command: process.execPath,
      args: [
        fixtureScript,
        NodePath.join(fixture.directory, "spawns.log"),
        NodePath.join(fixture.directory, "signals.log"),
      ],
    },
    ...(timeouts === undefined ? {} : { timeouts }),
  });

it.live("round-trips audio and handles over the worker channel", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const worker = yield* SpeechWorker.SpeechWorker;
    const first = yield* worker.create("runtime", { mode: "ok", text: "hello" });
    const transcript = yield* worker.decode(first, new Float32Array([0.5, -0.25, 3]), 16_000);
    assert.strictEqual(transcript, JSON.stringify({ text: "hello 3 0.5,-0.25,3", lang: "en" }));
    yield* worker.release(first);
    const second = yield* worker.create("runtime", { mode: "ok" });
    assert.strictEqual(second, first + 1);
    assert.strictEqual(fixture.spawns().length, 1);
  }).pipe(Effect.provide(testLayer(fixture)), Effect.scoped, Effect.ensuring(cleanup(fixture)));
});

it.live("round-trips a synthesized buffer and its handle", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const worker = yield* SpeechWorker.SpeechWorker;
    const handle = yield* worker.ttsCreate("runtime", { mode: "ok" });
    const generated = yield* worker.ttsGenerate({
      handleId: handle,
      text: "hello",
      sid: 3,
      speed: 1.5,
    });
    assert.ok(generated.samples instanceof Float32Array);
    assert.deepStrictEqual([...generated.samples], [3, 1.5, 5]);
    assert.strictEqual(generated.sampleRate, 24_000);
    yield* worker.ttsRelease(handle);
    const failing = yield* worker.ttsCreate("runtime", { mode: "fail" });
    const error = yield* worker
      .ttsGenerate({ handleId: failing, text: "hello", sid: 0, speed: 1 })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "SpeechWorkerError");
    assert.match(error.message, /fixture synthesis failed/);
    assert.strictEqual(fixture.spawns().length, 1);
  }).pipe(Effect.provide(testLayer(fixture)), Effect.scoped, Effect.ensuring(cleanup(fixture)));
});

it.live("fails an in-flight request when the worker crashes and respawns on demand", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const worker = yield* SpeechWorker.SpeechWorker;
    const dying = yield* worker.create("runtime", { mode: "crash" });
    const error = yield* worker.decode(dying, new Float32Array([1]), 16_000).pipe(Effect.flip);
    assert.strictEqual(error._tag, "SpeechWorkerGone");
    assert.strictEqual(fixture.spawns().length, 1);
    const replacement = yield* worker.create("runtime", { mode: "ok", text: "after" });
    const transcript = yield* worker.decode(replacement, new Float32Array([2]), 16_000);
    assert.strictEqual(transcript, JSON.stringify({ text: "after 1 2", lang: "en" }));
    assert.strictEqual(fixture.spawns().length, 2);
    assert.notStrictEqual(fixture.spawns()[0], fixture.spawns()[1]);
  }).pipe(Effect.provide(testLayer(fixture)), Effect.scoped, Effect.ensuring(cleanup(fixture)));
});

it.live("kills a worker that stops answering and fails that request", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const worker = yield* SpeechWorker.SpeechWorker;
    const stuck = yield* worker.create("runtime", { mode: "hang" });
    const error = yield* worker.decode(stuck, new Float32Array([1]), 16_000).pipe(Effect.flip);
    assert.strictEqual(error._tag, "SpeechWorkerGone");
    assert.match(error.message, /did not respond in time/);
    assert.strictEqual(fixture.spawns().length, 1);
    const replacement = yield* worker.create("runtime", { mode: "ok" });
    const transcript = yield* worker.decode(replacement, new Float32Array([7]), 16_000);
    assert.strictEqual(transcript, JSON.stringify({ text: "fixture 1 7", lang: "en" }));
    assert.strictEqual(fixture.spawns().length, 2);
  }).pipe(
    Effect.provide(testLayer(fixture, { create: 5_000, decode: 150, other: 5_000 })),
    Effect.scoped,
    Effect.ensuring(cleanup(fixture)),
  );
});

it.live("fails fast after three crashes inside the crash window", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const worker = yield* SpeechWorker.SpeechWorker;
    for (let attempt = 0; attempt < 3; attempt++) {
      const dying = yield* worker.create("runtime", { mode: "crash" });
      const error = yield* worker.decode(dying, new Float32Array([1]), 16_000).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SpeechWorkerGone");
    }
    assert.strictEqual(fixture.spawns().length, 3);
    const error = yield* worker.create("runtime", { mode: "ok" }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "SpeechWorkerGone");
    assert.match(error.message, /keeps crashing/);
    assert.strictEqual(fixture.spawns().length, 3);
  }).pipe(Effect.provide(testLayer(fixture)), Effect.scoped, Effect.ensuring(cleanup(fixture)));
});

it.live("does not count a clean idle exit as a crash", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const worker = yield* SpeechWorker.SpeechWorker;
    for (let cycle = 0; cycle < 3; cycle++) {
      const idle = yield* worker.create("runtime", { mode: "exit" });
      const error = yield* worker.decode(idle, new Float32Array([1]), 16_000).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SpeechWorkerGone");
    }
    const respawned = yield* worker.create("runtime", { mode: "ok" });
    assert.strictEqual(fixture.spawns().length, 4);
    const transcript = yield* worker.decode(respawned, new Float32Array([9]), 16_000);
    assert.strictEqual(transcript, JSON.stringify({ text: "fixture 1 9", lang: "en" }));
  }).pipe(Effect.provide(testLayer(fixture)), Effect.scoped, Effect.ensuring(cleanup(fixture)));
});

it.live("terminates the worker when the layer scope closes", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const worker = yield* SpeechWorker.SpeechWorker;
      yield* worker.create("runtime", { mode: "ok" });
    }).pipe(Effect.provide(testLayer(fixture)), Effect.scoped);
    for (let attempt = 0; attempt < 100 && fixture.signals().length === 0; attempt++) {
      yield* Effect.sleep("20 millis");
    }
    assert.deepEqual(fixture.signals(), ["SIGTERM"]);
  }).pipe(Effect.ensuring(cleanup(fixture)));
});
