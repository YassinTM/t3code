/**
 * Speech synthesis - text-to-speech for composer replies, rendered by an environment.
 *
 * The environment runs sherpa-onnx offline TTS with the pinned Kokoro English model in
 * the same out-of-process worker as dictation, and returns 16-bit mono PCM plus the
 * rate it was generated at. Nothing is downloaded until a client asks to install.
 *
 * @module Speech
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** `kokoro-en-v0_19` renders at this rate; the runtime never resamples. */
export const SPEECH_SAMPLE_RATE = 24_000;

/** The engine rejects text outside this range rather than speaking a partial reply. */
export const SPEECH_MIN_TEXT_LENGTH = 1;
export const SPEECH_MAX_TEXT_LENGTH = 1000;

export const SPEECH_MIN_SPEED = 0.5;
export const SPEECH_MAX_SPEED = 2;
export const SPEECH_DEFAULT_SPEED = 1;

export const SPEECH_DEFAULT_VOICE = 0;
export const SPEECH_MAX_VOICE = 10;

/**
 * `kokoro-en-v0_19` ships 11 voices; ids come from the model README's speaker map.
 * Names are for settings labels only: the wire and the native config carry the id.
 */
export const SPEECH_VOICES = [
  { id: 0, name: "af" },
  { id: 1, name: "af_bella" },
  { id: 2, name: "af_nicole" },
  { id: 3, name: "af_sarah" },
  { id: 4, name: "af_sky" },
  { id: 5, name: "am_adam" },
  { id: 6, name: "am_michael" },
  { id: 7, name: "bf_emma" },
  { id: 8, name: "bf_isabella" },
  { id: 9, name: "bm_george" },
  { id: 10, name: "bm_lewis" },
] as const;

export const SpeechVoice = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
});
export type SpeechVoice = typeof SpeechVoice.Type;

/** Client-facing view of the flat `speechEnabled`/`speechVoice`/`speechSpeed` server settings. */
export const SpeechSettings = Schema.Struct({
  enabled: Schema.Boolean,
  voice: Schema.Int,
  speed: Schema.Number,
});
export type SpeechSettings = typeof SpeechSettings.Type;

/** Install state of the Kokoro model artifact. */
export const SpeechInstallState = Schema.Union([
  Schema.TaggedStruct("not-installed", {}),
  Schema.TaggedStruct("installing", {
    receivedBytes: Schema.Number,
    totalBytes: Schema.Number,
  }),
  Schema.TaggedStruct("installed", { sizeBytes: Schema.Number }),
  Schema.TaggedStruct("failed", { message: Schema.String }),
]);
export type SpeechInstallState = typeof SpeechInstallState.Type;

/** Server-pushed speech state for one environment. */
export const SpeechState = Schema.Struct({
  /** False when this platform has no supported runtime build. */
  supported: Schema.Boolean,
  settings: SpeechSettings,
  install: SpeechInstallState,
  /** True when the model is loaded in the speech worker, so a synthesis starts immediately. */
  loaded: Schema.Boolean,
});
export type SpeechState = typeof SpeechState.Type;

export const SpeechSynthesizeInput = Schema.Struct({
  text: Schema.String,
  /** Kokoro speaker id; the server setting fills it in when omitted. */
  voice: Schema.optionalKey(Schema.Number),
  /** Multiplier over the model's own pace; clamped to 0.5-2.0. */
  speed: Schema.optionalKey(Schema.Number),
});
export type SpeechSynthesizeInput = typeof SpeechSynthesizeInput.Type;

export const SpeechSynthesizeResult = Schema.Struct({
  sampleRate: Schema.Number,
  /** Base64 of little-endian int16 mono PCM at `sampleRate`. */
  pcm16: Schema.String,
  durationMs: Schema.Number,
});
export type SpeechSynthesizeResult = typeof SpeechSynthesizeResult.Type;

export const SpeechErrorReason = Schema.Literals([
  "unsupported-platform",
  "disabled",
  "not-installed",
  "install-failed",
  "load-failed",
  "invalid-text",
  "invalid-voice",
  "synthesis-failed",
]);
export type SpeechErrorReason = typeof SpeechErrorReason.Type;

export class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  reason: SpeechErrorReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * Speech settings spread into the server settings structs from `DictationSettingsFields`,
 * so both feature areas reach every settings consumer through one upstream spread.
 */
export const SpeechSettingsFields = {
  server: {
    speechEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    speechVoice: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(SPEECH_DEFAULT_VOICE))),
    speechSpeed: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(SPEECH_DEFAULT_SPEED)),
    ),
  },
  serverPatch: {
    speechEnabled: Schema.optionalKey(Schema.Boolean),
    speechVoice: Schema.optionalKey(Schema.Int),
    speechSpeed: Schema.optionalKey(Schema.Number),
  },
} as const;
