import * as NodeOS from "node:os";
import {
  SPEECH_DEFAULT_SPEED,
  SPEECH_DEFAULT_VOICE,
  SPEECH_MAX_SPEED,
  SPEECH_MAX_TEXT_LENGTH,
  SPEECH_MAX_VOICE,
  SPEECH_MIN_SPEED,
  SPEECH_MIN_TEXT_LENGTH,
  SpeechError,
  type SpeechInstallState,
  type SpeechSettings,
  type SpeechState,
  type SpeechSynthesizeInput,
  type SpeechSynthesizeResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechArtifacts from "./SpeechArtifacts.ts";
import * as SpeechWorker from "./SpeechWorker.ts";
import { kokoroConfig } from "./models.ts";
import { encodePcm16 } from "./pcm.ts";

/** Free the model shortly after the last synthesis, like dictation's recognizer. */
const IDLE_UNLOAD_MS = 10 * 60_000;

interface Generated {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/**
 * Text-to-speech for composer replies. The Kokoro model is loaded on demand in the shared
 * speech worker, and one synthesis runs at a time: sherpa-onnx offline TTS is CPU-bound
 * and the generated buffers are large.
 */
export class SpeechSynthesis extends Context.Service<
  SpeechSynthesis,
  {
    readonly state: Effect.Effect<SpeechState>;
    readonly stateStream: Stream.Stream<SpeechState>;
    /** Starts or retries the model download; returns before it completes. */
    readonly install: Effect.Effect<void, SpeechError>;
    /** Removes the installed model, unloading it first. */
    readonly remove: Effect.Effect<void, SpeechError>;
    /** Loads the model ahead of a likely synthesis; a no-op when speech is off or uninstalled. */
    readonly warm: Effect.Effect<void>;
    readonly synthesize: (
      input: SpeechSynthesizeInput,
    ) => Effect.Effect<SpeechSynthesizeResult, SpeechError>;
  }
>()("t3/speech/SpeechSynthesis") {}

/** The engine rejects a voice outside the model's speakers rather than picking one. */
const clampSpeed = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(SPEECH_MAX_SPEED, Math.max(SPEECH_MIN_SPEED, value))
    : SPEECH_DEFAULT_SPEED;

const clampVoice = (value: number): number =>
  Number.isInteger(value) && value >= 0 && value <= SPEECH_MAX_VOICE ? value : SPEECH_DEFAULT_VOICE;

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const artifacts = yield* SpeechArtifacts.SpeechArtifacts;
  const worker = yield* SpeechWorker.SpeechWorker;
  const settingsChanges = yield* settingsService.subscribeChanges;
  const readSettings = settingsService.getSettings.pipe(
    Effect.map((current): SpeechSettings => ({
      enabled: current.speechEnabled,
      voice: clampVoice(current.speechVoice),
      speed: clampSpeed(current.speechSpeed),
    })),
    Effect.mapError(
      (cause) =>
        new SpeechError({
          reason: "disabled",
          message: "Could not read speech settings.",
          cause,
        }),
    ),
  );
  const initialSettings = yield* readSettings;
  // An unreadable state directory must not stop the server from starting; it reads as not installed.
  const installed = yield* artifacts.inspect.pipe(
    Effect.orElseSucceed((): SpeechInstallState => ({ _tag: "not-installed" })),
  );
  const state = yield* SubscriptionRef.make<SpeechState>({
    supported: artifacts.supported,
    settings: initialSettings,
    install: installed,
    loaded: false,
  });
  const update = (change: (current: SpeechState) => SpeechState) =>
    SubscriptionRef.update(state, change);
  // Native work cannot be cancelled. Hold its permit until it really returns, including on cancellation.
  const native = yield* Semaphore.make(1);
  const lifecycle = yield* Semaphore.make(1);
  let loadedHandle: number | null = null;
  let installing: Fiber.Fiber<void> | null = null;
  let lastUse = yield* Clock.currentTimeMillis;

  const loadConfig = (directory: string) =>
    kokoroConfig(
      (name) => path.join(directory, name),
      Math.min(4, Math.max(1, NodeOS.availableParallelism())),
    );

  /** Create the TTS handle once; callers hold the native permit. */
  const ensureHandle = Effect.fnUntraced(function* () {
    if (loadedHandle !== null) return loadedHandle;
    const runtimeDirectory = artifacts.runtimeDirectory;
    if (runtimeDirectory === null)
      return yield* new SpeechError({
        reason: "unsupported-platform",
        message: "Local speech is unavailable on this platform.",
      });
    const handleId = yield* worker
      .ttsCreate(runtimeDirectory, loadConfig(artifacts.directory))
      .pipe(
        Effect.mapError(
          (cause) =>
            new SpeechError({
              reason: "load-failed",
              message: "Could not load the speech model.",
              cause,
            }),
        ),
      );
    loadedHandle = handleId;
    yield* update((current) => ({ ...current, loaded: true }));
    return handleId;
  }, Effect.uninterruptible);

  const unload = Effect.fnUntraced(function* () {
    const previous = loadedHandle;
    loadedHandle = null;
    if (previous !== null)
      yield* native
        .withPermit(worker.ttsRelease(previous).pipe(Effect.ignore))
        .pipe(Effect.uninterruptible);
    yield* update((current) => ({ ...current, loaded: false }));
  });

  const reconcileSettings = Effect.fnUntraced(function* () {
    const next = yield* readSettings;
    const current = yield* SubscriptionRef.get(state);
    const changed =
      current.settings.enabled !== next.enabled ||
      current.settings.voice !== next.voice ||
      current.settings.speed !== next.speed;
    if (changed) yield* update((latest) => ({ ...latest, settings: next }));
    // Turning speech off must free the model; voice and speed only apply to later requests.
    if (!next.enabled && loadedHandle !== null) yield* unload();
  });

  const progress = (install: SpeechInstallState) => update((current) => ({ ...current, install }));

  const beginInstall = Effect.fnUntraced(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (!current.supported || current.install._tag === "installed" || installing) return;
    yield* progress({ _tag: "installing", receivedBytes: 0, totalBytes: 0 });
    installing = yield* artifacts.install(progress).pipe(
      Effect.catchTags({
        SpeechError: (error) =>
          Effect.sync(() => {
            installing = null;
          }).pipe(Effect.andThen(progress({ _tag: "failed", message: error.message }))),
      }),
      Effect.catchCause(() => progress({ _tag: "failed", message: "Speech installation failed." })),
      Effect.ensuring(
        Effect.sync(() => {
          installing = null;
        }),
      ),
      Effect.forkIn(scope),
    );
  }, Effect.uninterruptible);

  const install = Effect.gen(function* () {
    yield* reconcileSettings();
    const current = yield* SubscriptionRef.get(state);
    if (!current.supported)
      return yield* new SpeechError({
        reason: "unsupported-platform",
        message: "Local speech is unavailable on this platform.",
      });
    yield* beginInstall();
  }).pipe(lifecycle.withPermit);

  const remove = Effect.gen(function* () {
    yield* reconcileSettings();
    yield* unload();
    yield* progress({ _tag: "not-installed" });
    yield* artifacts.remove.pipe(
      Effect.catchTags({
        SpeechError: (error) =>
          Effect.gen(function* () {
            yield* progress({ _tag: "failed", message: error.message });
            return yield* error;
          }),
      }),
    );
  }).pipe(lifecycle.withPermit, Effect.uninterruptible);

  const warm = Effect.gen(function* () {
    yield* reconcileSettings();
    const current = yield* SubscriptionRef.get(state);
    if (loadedHandle !== null) return;
    if (current.supported && current.settings.enabled && current.install._tag === "installed") {
      yield* native.withPermit(
        Effect.gen(function* () {
          yield* ensureHandle();
          lastUse = yield* Clock.currentTimeMillis;
        }),
      );
    }
  }).pipe(lifecycle.withPermit, Effect.catchTags({ SpeechError: () => Effect.void }));

  /**
   * One synthesis at a time. A worker crash takes the handle with it, so the first
   * `SpeechWorkerGone` rebuilds the model once and retries the same text once.
   */
  const generate = Effect.fnUntraced(function* (
    handleId: number,
    request: { readonly text: string; readonly sid: number; readonly speed: number },
  ) {
    return yield* worker.ttsGenerate({ handleId, ...request }).pipe(
      Effect.catchTags({
        SpeechWorkerGone: () =>
          Effect.gen(function* () {
            // The worker crashed and took the handle with it. The remedy is the same as
            // unloading, but `synthesize` already holds the native permit this call runs under.
            loadedHandle = null;
            yield* update((current) => ({ ...current, loaded: false }));
            const rebuilt = yield* ensureHandle();
            return yield* worker.ttsGenerate({ handleId: rebuilt, ...request });
          }),
      }),
      Effect.mapError(
        (cause) =>
          new SpeechError({
            reason: "synthesis-failed",
            message: "Could not synthesize speech.",
            cause,
          }),
      ),
    );
  });

  const synthesize: SpeechSynthesis["Service"]["synthesize"] = Effect.fnUntraced(function* (input) {
    yield* reconcileSettings();
    const text = input.text.trim();
    if (text.length < SPEECH_MIN_TEXT_LENGTH || text.length > SPEECH_MAX_TEXT_LENGTH)
      return yield* new SpeechError({
        reason: "invalid-text",
        message: `Speech text must be ${SPEECH_MIN_TEXT_LENGTH}-${SPEECH_MAX_TEXT_LENGTH} characters.`,
      });
    const current = yield* SubscriptionRef.get(state);
    let voice: number;
    if (input.voice === undefined) {
      voice = current.settings.voice;
    } else if (
      !Number.isInteger(input.voice) ||
      input.voice < 0 ||
      input.voice > SPEECH_MAX_VOICE
    ) {
      return yield* new SpeechError({
        reason: "invalid-voice",
        message: `The speech voice must be an integer between 0 and ${SPEECH_MAX_VOICE}.`,
      });
    } else voice = input.voice;
    if (!current.supported)
      return yield* new SpeechError({
        reason: "unsupported-platform",
        message: "Local speech is unavailable on this platform.",
      });
    if (!current.settings.enabled)
      return yield* new SpeechError({
        reason: "disabled",
        message: "Enable local speech in environment settings.",
      });
    if (current.install._tag !== "installed")
      return yield* new SpeechError({
        reason: "not-installed",
        message: "Install the speech model first.",
      });
    const speed = input.speed === undefined ? current.settings.speed : clampSpeed(input.speed);
    const generated: Generated = yield* native.withPermit(
      Effect.gen(function* () {
        const handleId = yield* ensureHandle();
        const result = yield* generate(handleId, { text, sid: voice, speed });
        lastUse = yield* Clock.currentTimeMillis;
        return result;
      }).pipe(Effect.uninterruptible),
    );
    return {
      sampleRate: generated.sampleRate,
      pcm16: encodePcm16(generated.samples),
      durationMs: Math.round((generated.samples.length / generated.sampleRate) * 1_000),
    };
  });

  yield* settingsChanges.pipe(
    Stream.runForEach(() =>
      reconcileSettings().pipe(
        lifecycle.withPermit,
        Effect.catchTags({
          SpeechError: (error) =>
            Effect.logWarning("Could not reconcile speech settings.").pipe(
              Effect.annotateLogs({ reason: error.reason }),
            ),
        }),
      ),
    ),
    Effect.forkIn(scope),
  );
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (loadedHandle !== null && now - lastUse >= IDLE_UNLOAD_MS) yield* unload();
  }).pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkIn(scope));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const previous = loadedHandle;
      loadedHandle = null;
      if (previous !== null)
        yield* native.withPermit(worker.ttsRelease(previous).pipe(Effect.ignore));
    }),
  );
  yield* reconcileSettings().pipe(lifecycle.withPermit);
  return SpeechSynthesis.of({
    state: SubscriptionRef.get(state),
    stateStream: SubscriptionRef.changes(state),
    install,
    remove,
    warm,
    synthesize,
  });
});

export const layer = Layer.effect(SpeechSynthesis, make);
