import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type DictationInstallState, type DictationModelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";
import * as SpeechWorker from "../speech/SpeechWorker.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as DictationRecognizer from "./DictationRecognizer.ts";

const artifactsLayer = Layer.succeed(DictationArtifacts.DictationArtifacts, {
  supported: true,
  root: "/dictation",
  runtimeDirectory: "/dictation/runtime",
  paths: () => ({ runtime: "/dictation/runtime", model: "/dictation/models" }),
  ensureRuntime: () => Effect.void,
  inspect: Effect.succeed({
    runtime: { _tag: "installed", sizeBytes: 1 } satisfies DictationInstallState,
    models: new Map<DictationModelId, DictationInstallState>(),
  }),
  install: () => Effect.void,
  remove: () => Effect.void,
} satisfies DictationArtifacts.DictationArtifacts["Service"]);

const recognizerLayer = (worker: SpeechWorker.SpeechWorker["Service"]) =>
  DictationRecognizer.layer.pipe(
    Layer.provide(Layer.succeed(SpeechWorker.SpeechWorker, worker)),
    Layer.provide(artifactsLayer),
    Layer.provide(NodeServices.layer),
  );

interface CapturedConfig {
  readonly modelConfig: {
    readonly numThreads: number;
    readonly tokens: string;
    readonly transducer: { readonly encoder: string };
  };
}

const ok: SpeechWorker.SpeechWorker["Service"] = {
  create: () => Effect.succeed(1),
  setConfig: () => Effect.void,
  decode: () => Effect.succeed(JSON.stringify({ text: "hello world", lang: "en" })),
  release: () => Effect.void,
  ttsCreate: () => Effect.succeed(1),
  ttsGenerate: () => Effect.succeed({ samples: new Float32Array([0.1]), sampleRate: 24_000 }),
  ttsRelease: () => Effect.void,
};

it.effect("rebuilds the recognizer in the respawned worker and retries a decode once", () => {
  const created: Array<{ runtimeDir: string; config: unknown }> = [];
  const released: number[] = [];
  let decodes = 0;
  const worker: SpeechWorker.SpeechWorker["Service"] = {
    create: (runtimeDir, config) =>
      Effect.sync(() => {
        created.push({ runtimeDir, config });
        return created.length;
      }),
    setConfig: () => Effect.void,
    decode: () => {
      decodes++;
      return decodes === 1
        ? Effect.fail(new SpeechWorker.SpeechWorkerGone({ message: "the worker died" }))
        : Effect.succeed(JSON.stringify({ text: "hello world", lang: "en" }));
    },
    release: (handleId) =>
      Effect.sync(() => {
        released.push(handleId);
      }),
    ttsCreate: () => Effect.succeed(1),
    ttsGenerate: () => Effect.succeed({ samples: new Float32Array([0.1]), sampleRate: 24_000 }),
    ttsRelease: () => Effect.void,
  };
  return Effect.gen(function* () {
    const service = yield* DictationRecognizer.DictationRecognizer;
    const recognizer = yield* service.load("parakeet-v3", "auto");
    const result = yield* recognizer.decode(new Float32Array([0.5, 0.5]), "auto");
    assert.deepEqual(result, { text: "hello world", locale: "en" });
    assert.strictEqual(decodes, 2);
    assert.deepEqual(
      created.map((entry) => entry.runtimeDir),
      ["/dictation/runtime", "/dictation/runtime"],
    );
    const config = created[0]!.config as CapturedConfig;
    assert.strictEqual(config.modelConfig.tokens, "/dictation/models/tokens.txt");
    assert.strictEqual(
      config.modelConfig.transducer.encoder,
      "/dictation/models/encoder.int8.onnx",
    );
    assert.strictEqual(
      config.modelConfig.numThreads,
      Math.min(4, Math.max(1, NodeOS.availableParallelism())),
    );
    yield* recognizer.release;
    assert.deepEqual(released, [2]);
  }).pipe(Effect.provide(recognizerLayer(worker)), Effect.scoped);
});

it.effect("gives up with transcription-failed when the retry decode also dies", () => {
  let decodes = 0;
  const worker: SpeechWorker.SpeechWorker["Service"] = {
    ...ok,
    decode: () => {
      decodes++;
      return Effect.fail(new SpeechWorker.SpeechWorkerGone({ message: "the worker died" }));
    },
  };
  return Effect.gen(function* () {
    const service = yield* DictationRecognizer.DictationRecognizer;
    const recognizer = yield* service.load("parakeet-v3", "auto");
    const error = yield* recognizer.decode(new Float32Array([0.5, 0.5]), "auto").pipe(Effect.flip);
    assert.strictEqual(error.reason, "transcription-failed");
    assert.strictEqual(error.message, "Could not transcribe the recording.");
    assert.strictEqual(decodes, 2);
  }).pipe(Effect.provide(recognizerLayer(worker)), Effect.scoped);
});

it.effect("maps a recognizer that cannot be rebuilt on retry to transcription-failed", () => {
  let creates = 0;
  const worker: SpeechWorker.SpeechWorker["Service"] = {
    ...ok,
    create: () => {
      creates++;
      return creates === 1
        ? Effect.succeed(1)
        : Effect.fail(new SpeechWorker.SpeechWorkerError({ message: "no more models" }));
    },
    decode: () => Effect.fail(new SpeechWorker.SpeechWorkerGone({ message: "the worker died" })),
  };
  return Effect.gen(function* () {
    const service = yield* DictationRecognizer.DictationRecognizer;
    const recognizer = yield* service.load("parakeet-v3", "auto");
    const error = yield* recognizer.decode(new Float32Array([0.5, 0.5]), "auto").pipe(Effect.flip);
    assert.strictEqual(error.reason, "transcription-failed");
    assert.strictEqual(creates, 2);
  }).pipe(Effect.provide(recognizerLayer(worker)), Effect.scoped);
});

it.effect("maps a failed load to load-failed", () => {
  const worker: SpeechWorker.SpeechWorker["Service"] = {
    ...ok,
    create: () => Effect.fail(new SpeechWorker.SpeechWorkerError({ message: "no native addon" })),
  };
  return Effect.gen(function* () {
    const service = yield* DictationRecognizer.DictationRecognizer;
    const error = yield* service.load("parakeet-v3", "auto").pipe(Effect.flip);
    assert.strictEqual(error.reason, "load-failed");
    assert.strictEqual(error.message, "Could not load the dictation model.");
  }).pipe(Effect.provide(recognizerLayer(worker)), Effect.scoped);
});

it.effect("skips the worker entirely for quiet whisper audio", () => {
  let decodes = 0;
  const worker: SpeechWorker.SpeechWorker["Service"] = {
    ...ok,
    decode: () => {
      decodes++;
      return ok.decode(1, new Float32Array(), 16_000);
    },
  };
  return Effect.gen(function* () {
    const service = yield* DictationRecognizer.DictationRecognizer;
    const recognizer = yield* service.load("whisper-turbo", "en");
    const result = yield* recognizer.decode(new Float32Array(16_000), "en");
    assert.deepEqual(result, { text: "", locale: "en" });
    assert.strictEqual(decodes, 0);
  }).pipe(Effect.provide(recognizerLayer(worker)), Effect.scoped);
});
