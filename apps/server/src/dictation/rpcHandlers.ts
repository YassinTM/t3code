import {
  DICTATION_WS_METHODS,
  VOICE_REQUEST_NONE,
  type DictationError,
  type SpeechError,
  type VoiceRequestPayload,
  type VoiceRequestResult,
  type VoiceStateEvent,
  type VoiceStateTopic,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeSpeechRpcHandlers } from "../speech/rpcHandlers.ts";
import * as Dictation from "./Dictation.ts";

/** Dictation and speech RPC handlers, spread into the WebSocket handler map in `ws.ts`. */
export const makeDictationRpcHandlers = Effect.gen(function* () {
  const dictation = yield* Dictation.Dictation;
  const speech = yield* makeSpeechRpcHandlers;

  const dispatch = (
    input: VoiceRequestPayload,
  ): Effect.Effect<VoiceRequestResult, DictationError | SpeechError> => {
    switch (input._tag) {
      case "dictation.install":
        return dictation.install(input).pipe(Effect.as(VOICE_REQUEST_NONE));
      case "dictation.remove":
        return dictation.remove(input).pipe(Effect.as(VOICE_REQUEST_NONE));
      case "dictation.start":
        return dictation.start.pipe(
          Effect.map((result): VoiceRequestResult => ({
            _tag: "dictation.started",
            sessionId: result.sessionId,
          })),
        );
      case "dictation.warm":
        return dictation.warm.pipe(Effect.as(VOICE_REQUEST_NONE));
      case "dictation.append":
        return dictation.append(input).pipe(Effect.as(VOICE_REQUEST_NONE));
      case "dictation.finish":
        return dictation.finish(input).pipe(
          Effect.map((result): VoiceRequestResult => ({
            _tag: "dictation.finished",
            text: result.text,
            locale: result.locale,
          })),
        );
      case "dictation.cancel":
        return dictation.cancel(input).pipe(Effect.as(VOICE_REQUEST_NONE));
      case "speech.install":
      case "speech.remove":
      case "speech.warm":
      case "speech.synthesize":
        return speech.request(input);
      default: {
        const unreachable: never = input;
        return unreachable;
      }
    }
  };

  const stateStream = (topic: VoiceStateTopic): Stream.Stream<VoiceStateEvent> =>
    topic === "dictation"
      ? dictation.stateStream.pipe(
          Stream.map((state): VoiceStateEvent => ({ _tag: "dictation", state })),
        )
      : speech.stateStream.pipe(
          Stream.map((state): VoiceStateEvent => ({ _tag: "speech", state })),
        );

  return {
    [DICTATION_WS_METHODS.voiceRequest]: dispatch,
    [DICTATION_WS_METHODS.subscribeVoiceState]: (input: { topic: VoiceStateTopic }) =>
      stateStream(input.topic),
  };
});
