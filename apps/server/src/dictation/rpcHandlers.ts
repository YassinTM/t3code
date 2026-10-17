import { DICTATION_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Dictation from "./Dictation.ts";

/** Dictation RPC handlers, spread into the WebSocket handler map in `ws.ts`. */
export const makeDictationRpcHandlers = Effect.gen(function* () {
  const dictation = yield* Dictation.Dictation;
  return {
    [DICTATION_WS_METHODS.dictationInstall]: (input: Parameters<typeof dictation.install>[0]) =>
      dictation.install(input),
    [DICTATION_WS_METHODS.dictationRemove]: (input: Parameters<typeof dictation.remove>[0]) =>
      dictation.remove(input),
    [DICTATION_WS_METHODS.dictationStart]: () => dictation.start,
    [DICTATION_WS_METHODS.dictationWarm]: () => dictation.warm,
    [DICTATION_WS_METHODS.dictationAppend]: (input: Parameters<typeof dictation.append>[0]) =>
      dictation.append(input),
    [DICTATION_WS_METHODS.dictationFinish]: (input: Parameters<typeof dictation.finish>[0]) =>
      dictation.finish(input),
    [DICTATION_WS_METHODS.dictationCancel]: (input: Parameters<typeof dictation.cancel>[0]) =>
      dictation.cancel(input),
    [DICTATION_WS_METHODS.subscribeDictationState]: () => dictation.stateStream,
  };
});
