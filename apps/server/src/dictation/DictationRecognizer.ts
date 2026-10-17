import * as NodeOS from "node:os";
import * as Path from "effect/Path";
import {
  DictationError,
  DICTATION_SAMPLE_RATE,
  type DictationFinishResult,
  type DictationModelId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SpeechWorker from "../speech/SpeechWorker.ts";
import { isQuiet } from "./audio.ts";
import { models, resolveLanguage } from "./models.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";

interface OfflineConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: ReturnType<(typeof models)[DictationModelId]["modelConfig"]> & {
    numThreads: number;
    provider: "cpu";
    debug: number;
  };
}

const Result = Schema.fromJsonString(
  Schema.Struct({ text: Schema.String, lang: Schema.optionalKey(Schema.String) }),
);

const decodeResult = Schema.decodeEffect(Result);

export interface Recognizer {
  readonly decode: (
    samples: Float32Array,
    language: string,
  ) => Effect.Effect<DictationFinishResult, DictationError>;
  /** Drop the N-API external handle; its native finalizer owns freeing model memory. */
  readonly release: Effect.Effect<void>;
}

export class DictationRecognizer extends Context.Service<
  DictationRecognizer,
  {
    readonly load: (
      model: DictationModelId,
      language: string,
    ) => Effect.Effect<Recognizer, DictationError>;
  }
>()("t3/dictation/DictationRecognizer") {}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const artifacts = yield* DictationArtifacts.DictationArtifacts;
  const worker = yield* SpeechWorker.SpeechWorker;
  const load = Effect.fnUntraced(function* (model: DictationModelId, language: string) {
    const locations = artifacts.paths(model);
    const configFor = (language: string): OfflineConfig => ({
      featConfig: { sampleRate: DICTATION_SAMPLE_RATE, featureDim: models[model].featureDim },
      modelConfig: {
        ...models[model].modelConfig((name) => path.join(locations.model, name), language),
        // Leave CPU for the agents sharing the host; dictation is background work.
        numThreads: Math.min(4, Math.max(1, NodeOS.availableParallelism())),
        provider: "cpu",
        debug: 0,
      },
    });
    // The native recognizer lives in the speech worker and dies with it, so a handle is only
    // valid until the next `SpeechWorkerGone`.
    const open = (language: string) => worker.create(locations.runtime, configFor(language));
    let currentLanguage = resolveLanguage(model, language);
    let handleId = yield* open(currentLanguage).pipe(
      Effect.mapError(
        (cause) =>
          new DictationError({
            reason: "load-failed",
            message: "Could not load the dictation model.",
            cause,
          }),
      ),
    );
    const transcribe = (samples: Float32Array, pinnedLanguage: string) =>
      Effect.gen(function* () {
        if (pinnedLanguage !== currentLanguage) {
          yield* worker.setConfig(handleId, configFor(pinnedLanguage));
          currentLanguage = pinnedLanguage;
        }
        return yield* worker.decode(handleId, samples, DICTATION_SAMPLE_RATE);
      }).pipe(
        Effect.catchTags({
          // The worker crashed and took the recognizer with it. The next request respawns it,
          // so rebuild the recognizer once and retry this decode once.
          SpeechWorkerGone: () =>
            Effect.gen(function* () {
              currentLanguage = pinnedLanguage;
              handleId = yield* open(pinnedLanguage);
              return yield* worker.decode(handleId, samples, DICTATION_SAMPLE_RATE);
            }),
        }),
      );
    const decode = (samples: Float32Array, language: string) =>
      Effect.gen(function* () {
        const pinnedLanguage = resolveLanguage(model, language);
        if (models[model].skipSilence && isQuiet(samples))
          return { text: "", locale: pinnedLanguage || "en" };
        const json = yield* transcribe(samples, pinnedLanguage).pipe(
          Effect.mapError(
            (cause) =>
              new DictationError({
                reason: "transcription-failed",
                message: "Could not transcribe the recording.",
                cause,
              }),
          ),
        );
        const result = yield* decodeResult(json).pipe(
          // Schema failures can contain transcript fragments, so keep this domain validation error private.
          Effect.mapError(
            () =>
              new DictationError({
                reason: "transcription-failed",
                message: "The dictation runtime returned an invalid result.",
              }),
          ),
        );
        return {
          text: models[model].cleanText(result.text),
          locale: result.lang || pinnedLanguage || "en",
        };
      });
    return {
      decode,
      release: Effect.suspend(() => worker.release(handleId).pipe(Effect.ignore)),
    } satisfies Recognizer;
  });
  return DictationRecognizer.of({ load });
});

export const layer = Layer.effect(DictationRecognizer, make);
