import { DICTATION_WS_METHODS } from "@t3tools/contracts";

/** Trace aggregate label for the dictation and speech RPC methods. */
export const DICTATION_RPC_AGGREGATES = {
  [DICTATION_WS_METHODS.voiceRequest]: "voice",
  [DICTATION_WS_METHODS.subscribeVoiceState]: "voice",
} as const;
