import { DICTATION_WS_METHODS } from "@t3tools/contracts";

/** Trace aggregate label for every dictation RPC method. */
export const DICTATION_RPC_AGGREGATES = {
  [DICTATION_WS_METHODS.dictationInstall]: "dictation",
  [DICTATION_WS_METHODS.dictationRemove]: "dictation",
  [DICTATION_WS_METHODS.dictationStart]: "dictation",
  [DICTATION_WS_METHODS.dictationWarm]: "dictation",
  [DICTATION_WS_METHODS.dictationAppend]: "dictation",
  [DICTATION_WS_METHODS.dictationFinish]: "dictation",
  [DICTATION_WS_METHODS.dictationCancel]: "dictation",
  [DICTATION_WS_METHODS.subscribeDictationState]: "dictation",
} as const;
