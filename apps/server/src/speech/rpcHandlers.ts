import {
  VOICE_REQUEST_NONE,
  type SpeechError,
  type VoiceRequestPayload,
  type VoiceRequestResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SpeechSynthesis from "./SpeechSynthesis.ts";

/** The speech variants of the shared `voice.request` payload. */
export type SpeechVoiceRequest = Extract<
  VoiceRequestPayload,
  { _tag: "speech.install" | "speech.remove" | "speech.warm" | "speech.synthesize" }
>;

/**
 * The speech half of the `voice.request` dispatcher, spread into the dictation handler map in
 * `dictation/rpcHandlers.ts`. `request` answers exactly the former per-method handlers did,
 * wrapped in the shared tagged result union.
 */
export const makeSpeechRpcHandlers = Effect.gen(function* () {
  const speech = yield* SpeechSynthesis.SpeechSynthesis;
  return {
    request: (input: SpeechVoiceRequest): Effect.Effect<VoiceRequestResult, SpeechError> => {
      switch (input._tag) {
        case "speech.install":
          return speech.install.pipe(Effect.as(VOICE_REQUEST_NONE));
        case "speech.remove":
          return speech.remove.pipe(Effect.as(VOICE_REQUEST_NONE));
        case "speech.warm":
          return speech.warm.pipe(Effect.as(VOICE_REQUEST_NONE));
        case "speech.synthesize":
          return speech.synthesize(input).pipe(
            Effect.map((result): VoiceRequestResult => ({
              _tag: "speech.synthesized",
              sampleRate: result.sampleRate,
              pcm16: result.pcm16,
              durationMs: result.durationMs,
            })),
          );
        default: {
          const unreachable: never = input;
          return unreachable;
        }
      }
    },
    stateStream: speech.stateStream,
  };
});
