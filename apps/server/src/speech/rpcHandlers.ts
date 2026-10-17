import { DICTATION_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SpeechSynthesis from "./SpeechSynthesis.ts";

/** Speech RPC handlers, spread into the dictation handler map in `dictation/rpcHandlers.ts`. */
export const makeSpeechRpcHandlers = Effect.gen(function* () {
  const speech = yield* SpeechSynthesis.SpeechSynthesis;
  return {
    [DICTATION_WS_METHODS.speechInstall]: () => speech.install,
    [DICTATION_WS_METHODS.speechRemove]: () => speech.remove,
    [DICTATION_WS_METHODS.speechWarm]: () => speech.warm,
    [DICTATION_WS_METHODS.speechSynthesize]: (input: Parameters<typeof speech.synthesize>[0]) =>
      speech.synthesize(input),
    [DICTATION_WS_METHODS.subscribeSpeechState]: () => speech.stateStream,
  };
});
