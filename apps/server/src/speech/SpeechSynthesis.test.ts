import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type SpeechInstallState,
  SpeechError,
  type SpeechSynthesizeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechArtifacts from "./SpeechArtifacts.ts";
import * as SpeechSynthesis from "./SpeechSynthesis.ts";
import * as SpeechWorker from "./SpeechWorker.ts";

type Workers = SpeechWorker.SpeechWorker["Service"];
type Artifacts = SpeechArtifacts.SpeechArtifacts["Service"];

const installed = (sizeBytes = 1): SpeechInstallState => ({ _tag: "installed", sizeBytes });

const workerStub = (overrides: Partial<Workers> = {}): Workers => ({
  create: () => Effect.succeed(0),
  setConfig: () => Effect.void,
  decode: () => Effect.succeed(""),
  release: () => Effect.void,
  ttsCreate: () => Effect.succeed(1),
  ttsGenerate: () => Effect.succeed({ samples: new Float32Array([0.5]), sampleRate: 24_000 }),
  ttsRelease: () => Effect.void,
  ...overrides,
});

const artifactsStub = (overrides: Partial<Artifacts> = {}): Artifacts => ({
  supported: true,
  directory: "/models/tts/kokoro-en-v0_19",
  runtimeDirectory: "/runtime",
  inspect: Effect.succeed(installed()),
  install: (progress) => progress(installed()),
  remove: Effect.void,
  ...overrides,
});

/** Test settings service that also publishes changes, so reconcile-on-change can be observed. */
const settingsLayer = (overrides: Parameters<typeof ServerSettings.layerTest>[0]) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const original = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<import("@t3tools/contracts").ServerSettings>();
      return {
        ...original,
        updateSettings: (patch) =>
          original.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      } satisfies ServerSettings.ServerSettingsService["Service"];
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest(overrides)));

interface Options {
  readonly settings?: {
    readonly enabled?: boolean;
    readonly voice?: number;
    readonly speed?: number;
  };
  readonly artifacts?: Partial<Artifacts>;
  readonly worker?: Partial<Workers>;
}

const layer = (options: Options = {}) =>
  SpeechSynthesis.layer.pipe(
    Layer.provideMerge(
      settingsLayer({
        speechEnabled: options.settings?.enabled ?? true,
        speechVoice: options.settings?.voice ?? 0,
        speechSpeed: options.settings?.speed ?? 1,
      }),
    ),
    Layer.provide(Layer.succeed(SpeechArtifacts.SpeechArtifacts, artifactsStub(options.artifacts))),
    Layer.provide(Layer.succeed(SpeechWorker.SpeechWorker, workerStub(options.worker))),
    Layer.provideMerge(NodeServices.layer),
  );

/** Independent little-endian int16 conversion so the assertion does not reuse the implementation. */
const expectedPcm = (samples: ReadonlyArray<number>, sampleRate: number) => {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) =>
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32_767), index * 2),
  );
  return {
    sampleRate,
    pcm16: bytes.toString("base64"),
    durationMs: Math.round((samples.length / sampleRate) * 1_000),
  };
};

it.effect("gates synthesis on platform, settings, install state and input", () =>
  Effect.gen(function* () {
    const reasonFor = (options: Options, input: SpeechSynthesizeInput) =>
      Effect.gen(function* () {
        const service = yield* SpeechSynthesis.SpeechSynthesis;
        return (yield* service.synthesize(input).pipe(Effect.flip)).reason;
      }).pipe(Effect.provide(layer(options)), Effect.scoped);

    assert.strictEqual(
      yield* reasonFor(
        { artifacts: { supported: false, runtimeDirectory: null } },
        { text: "hello" },
      ),
      "unsupported-platform",
    );
    assert.strictEqual(
      yield* reasonFor({ settings: { enabled: false } }, { text: "hello" }),
      "disabled",
    );
    assert.strictEqual(
      yield* reasonFor(
        { artifacts: { inspect: Effect.succeed({ _tag: "not-installed" }) } },
        { text: "hello" },
      ),
      "not-installed",
    );
    // Text and voice are validated before the install/platform gates.
    assert.strictEqual(yield* reasonFor({}, { text: "   " }), "invalid-text");
    assert.strictEqual(yield* reasonFor({}, { text: "x".repeat(1_001) }), "invalid-text");
    assert.strictEqual(yield* reasonFor({}, { text: "hello", voice: 11 }), "invalid-voice");
    assert.strictEqual(yield* reasonFor({}, { text: "hello", voice: 1.5 }), "invalid-voice");
  }),
);

it.effect("returns clamped PCM and applies the settings voice and speed when omitted", () => {
  const requests: Array<{ text: string; sid: number; speed: number }> = [];
  const samples = [0, 0.5, -1, 2];
  return Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;

    const result = yield* service.synthesize({ text: "  hello  " });
    assert.deepStrictEqual(requests, [{ text: "hello", sid: 3, speed: 1.5 }]);
    assert.deepStrictEqual(result, expectedPcm(samples, 24_000));

    // An explicit voice and speed win over the settings; the speed is clamped to 2.
    yield* service.synthesize({ text: "hello", voice: 5, speed: 9 });
    assert.deepStrictEqual(requests[1], { text: "hello", sid: 5, speed: 2 });
    yield* service.synthesize({ text: "hello", speed: 0.1 });
    assert.deepStrictEqual(requests[2], { text: "hello", sid: 3, speed: 0.5 });
  }).pipe(
    Effect.provide(
      layer({
        settings: { voice: 3, speed: 1.5 },
        worker: {
          ttsGenerate: (input) =>
            Effect.sync(() => {
              requests.push({ text: input.text, sid: input.sid, speed: input.speed });
              return { samples: new Float32Array(samples), sampleRate: 24_000 };
            }),
        },
      }),
    ),
    Effect.scoped,
  );
});

it.effect("falls back to the default voice when the setting is out of range", () => {
  const voices: number[] = [];
  return Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    yield* service.synthesize({ text: "hello" });
    assert.deepStrictEqual(voices, [0]);
  }).pipe(
    Effect.provide(
      layer({
        settings: { voice: 99 },
        worker: {
          ttsGenerate: (input) =>
            Effect.sync(() => {
              voices.push(input.sid);
              return { samples: new Float32Array([0.1]), sampleRate: 24_000 };
            }),
        },
      }),
    ),
    Effect.scoped,
  );
});

it.effect("serializes syntheses so the native engine runs one at a time", () => {
  let active = 0;
  let maxActive = 0;
  return Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    const first = yield* service.synthesize({ text: "one" }).pipe(Effect.forkChild);
    const second = yield* service.synthesize({ text: "two" }).pipe(Effect.forkChild);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.strictEqual(maxActive, 1);
  }).pipe(
    Effect.provide(
      layer({
        worker: {
          ttsGenerate: () =>
            Effect.gen(function* () {
              active++;
              maxActive = Math.max(maxActive, active);
              for (let turn = 0; turn < 5; turn++) yield* Effect.yieldNow;
              active--;
              return { samples: new Float32Array([0.1]), sampleRate: 24_000 };
            }),
        },
      }),
    ),
    Effect.scoped,
  );
});

it.effect("rebuilds the model once when the worker is gone and retries the same text", () => {
  let creates = 0;
  let generates = 0;
  return Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    const result = yield* service.synthesize({ text: "hello" });
    assert.strictEqual(creates, 2);
    assert.strictEqual(generates, 2);
    assert.deepStrictEqual(result, expectedPcm([0.1], 24_000));
    assert.strictEqual((yield* service.state).loaded, true);
  }).pipe(
    Effect.provide(
      layer({
        worker: {
          ttsCreate: () =>
            Effect.sync(() => {
              creates++;
              return creates;
            }),
          ttsGenerate: () =>
            Effect.gen(function* () {
              generates++;
              if (generates === 1)
                return yield* new SpeechWorker.SpeechWorkerGone({ message: "worker crashed" });
              return { samples: new Float32Array([0.1]), sampleRate: 24_000 };
            }),
        },
      }),
    ),
    Effect.scoped,
  );
});

it.effect("reports a synthesis failure when the worker stays gone", () =>
  Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    const error = yield* service.synthesize({ text: "hello" }).pipe(Effect.flip);
    assert.strictEqual(error.reason, "synthesis-failed");
    // The retry rebuilt the handle before the second failure, so the test only asserts the mapping.
  }).pipe(
    Effect.provide(
      layer({
        worker: {
          ttsGenerate: () =>
            Effect.fail(new SpeechWorker.SpeechWorkerGone({ message: "worker crashed" })),
        },
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("unloads an idle model and loads it again for the next request", () => {
  let creates = 0;
  const releases: Array<number> = [];
  return Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    yield* service.synthesize({ text: "first" });
    assert.strictEqual((yield* service.state).loaded, true);

    yield* TestClock.adjust("11 minutes");
    yield* service.stateStream.pipe(
      Stream.filter((state) => !state.loaded),
      Stream.take(1),
      Stream.runDrain,
    );
    assert.deepStrictEqual(releases, [1]);

    yield* service.synthesize({ text: "second" });
    assert.strictEqual(creates, 2);
  }).pipe(
    Effect.provide(
      layer({
        worker: {
          ttsCreate: () =>
            Effect.sync(() => {
              creates++;
              return creates;
            }),
          ttsRelease: (handleId) =>
            Effect.sync(() => {
              releases.push(handleId);
            }),
        },
      }),
    ),
    Effect.scoped,
  );
});

it.effect("turning speech off unloads the loaded model", () => {
  const releases: Array<number> = [];
  return Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* service.synthesize({ text: "hello" });
    assert.strictEqual((yield* service.state).loaded, true);

    yield* settings.updateSettings({ speechEnabled: false });
    yield* service.stateStream.pipe(
      Stream.filter((state) => !state.loaded),
      Stream.take(1),
      Stream.runDrain,
    );
    assert.deepStrictEqual(releases, [1]);
    assert.strictEqual((yield* service.state).settings.enabled, false);
  }).pipe(
    Effect.provide(
      layer({
        worker: {
          ttsRelease: (handleId) =>
            Effect.sync(() => {
              releases.push(handleId);
            }),
        },
      }),
    ),
    Effect.scoped,
  );
});

it.effect("forks install with progress, then removal unloads before deleting", () => {
  const progress: Array<SpeechInstallState> = [];
  let removals = 0;
  const releases: Array<number> = [];
  return Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    yield* service.install;
    yield* service.stateStream.pipe(
      Stream.filter((state) => state.install._tag === "installed"),
      Stream.take(1),
      Stream.runDrain,
    );
    assert.ok(progress.some((state) => state._tag === "installing"));
    assert.strictEqual((yield* service.state).install._tag, "installed");

    yield* service.synthesize({ text: "hello" });
    yield* service.remove;
    assert.deepStrictEqual(releases, [1]);
    assert.strictEqual(removals, 1);
    assert.strictEqual((yield* service.state).install._tag, "not-installed");
  }).pipe(
    Effect.provide(
      layer({
        artifacts: {
          inspect: Effect.succeed({ _tag: "not-installed" }),
          install: (report) =>
            Effect.gen(function* () {
              progress.push({ _tag: "installing", receivedBytes: 0, totalBytes: 0 });
              yield* report({ _tag: "installing", receivedBytes: 0, totalBytes: 0 });
              yield* report(installed(5));
            }),
          remove: Effect.sync(() => {
            removals++;
          }),
        },
        worker: {
          ttsRelease: (handleId) =>
            Effect.sync(() => {
              releases.push(handleId);
            }),
        },
      }),
    ),
    Effect.scoped,
  );
});

it.effect("refuses to install on an unsupported platform", () =>
  Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    const error = yield* service.install.pipe(Effect.flip);
    assert.strictEqual(error.reason, "unsupported-platform");
    assert.strictEqual((yield* service.state).supported, false);
  }).pipe(
    Effect.provide(layer({ artifacts: { supported: false, runtimeDirectory: null } })),
    Effect.scoped,
  ),
);

it.effect("keeps install state honest when removal fails", () =>
  Effect.gen(function* () {
    const service = yield* SpeechSynthesis.SpeechSynthesis;
    const error = yield* service.remove.pipe(Effect.flip);
    assert.strictEqual(error.reason, "install-failed");
    assert.strictEqual((yield* service.state).install._tag, "failed");
  }).pipe(
    Effect.provide(
      layer({
        artifacts: {
          remove: Effect.fail(
            new SpeechError({ reason: "install-failed", message: "Could not delete the model." }),
          ),
        },
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("warm loads once ahead of a request and is a no-op when speech is off", () => {
  let creates = 0;
  const warmLayer = (enabled: boolean) =>
    layer({
      settings: { enabled },
      worker: {
        ttsCreate: () =>
          Effect.sync(() => {
            creates++;
            return creates;
          }),
      },
    });
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const service = yield* SpeechSynthesis.SpeechSynthesis;
      yield* service.warm;
      yield* service.warm;
      yield* Effect.yieldNow;
      assert.strictEqual((yield* service.state).loaded, true);
      assert.strictEqual(creates, 1);
    }).pipe(Effect.provide(warmLayer(true)), Effect.scoped);

    creates = 0;
    yield* Effect.gen(function* () {
      const service = yield* SpeechSynthesis.SpeechSynthesis;
      yield* service.warm;
      yield* Effect.yieldNow;
      assert.strictEqual((yield* service.state).loaded, false);
      assert.strictEqual(creates, 0);
    }).pipe(Effect.provide(warmLayer(false)), Effect.scoped);
  });
});
