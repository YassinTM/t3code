/**
 * Dictation and speech RPC definitions, kept apart from `rpc.ts` and spread into
 * `WS_METHODS` / `WsRpcGroup` there.
 *
 * Dictation and speech synthesis share one runtime, worker and settings spread, so they also
 * share a single transport surface: `voice.request` carries every former per-operation method
 * as a tagged payload, and `subscribeVoiceState` carries both state streams. Keeping the fork
 * to two RPC slots keeps the WebSocket RPC group inside TypeScript's instantiation budget.
 *
 * @module DictationRpc
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  DictationAppendInput,
  DictationCancelInput,
  DictationError,
  DictationFinishInput,
  DictationFinishResult,
  DictationInstallInput,
  DictationRemoveInput,
  DictationStartResult,
  DictationState,
  SpeechError,
  SpeechState,
  SpeechSynthesizeInput,
  SpeechSynthesizeResult,
} from "./dictation.ts";

export const DICTATION_WS_METHODS = {
  voiceRequest: "voice.request",
  subscribeVoiceState: "subscribeVoiceState",
} as const;

/**
 * Every dictation and speech operation, tagged. Each variant carries exactly the fields its
 * former dedicated RPC took, so the dispatcher can call the same service method unchanged.
 */
export const VoiceRequestPayload = Schema.Union([
  Schema.TaggedStruct("dictation.install", { ...DictationInstallInput.fields }),
  Schema.TaggedStruct("dictation.remove", { ...DictationRemoveInput.fields }),
  Schema.TaggedStruct("dictation.start", {}),
  Schema.TaggedStruct("dictation.warm", {}),
  Schema.TaggedStruct("dictation.append", { ...DictationAppendInput.fields }),
  Schema.TaggedStruct("dictation.finish", { ...DictationFinishInput.fields }),
  Schema.TaggedStruct("dictation.cancel", { ...DictationCancelInput.fields }),
  Schema.TaggedStruct("speech.install", {}),
  Schema.TaggedStruct("speech.remove", {}),
  Schema.TaggedStruct("speech.warm", {}),
  Schema.TaggedStruct("speech.synthesize", { ...SpeechSynthesizeInput.fields }),
]);
export type VoiceRequestPayload = typeof VoiceRequestPayload.Type;

/**
 * Success shape of `voice.request`: every former result spread under its own tag, and `none`
 * for the operations that returned nothing. No variant is wrapped, so a result is the tagged
 * value itself and the dispatcher returns it directly.
 */
export const VoiceRequestResult = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("dictation.started", { ...DictationStartResult.fields }),
  Schema.TaggedStruct("dictation.finished", { ...DictationFinishResult.fields }),
  Schema.TaggedStruct("speech.synthesized", { ...SpeechSynthesizeResult.fields }),
]);
export type VoiceRequestResult = typeof VoiceRequestResult.Type;

/** The tagged result every former void operation answers with. */
export const VOICE_REQUEST_NONE = { _tag: "none" } as const satisfies VoiceRequestResult;

/** Which state stream a `subscribeVoiceState` subscriber wants. */
export const VoiceStateTopic = Schema.Literals(["dictation", "speech"]);
export type VoiceStateTopic = typeof VoiceStateTopic.Type;

/** One state push, tagged so a client can tell the two streams apart by construction. */
export const VoiceStateEvent = Schema.Union([
  Schema.TaggedStruct("dictation", { state: DictationState }),
  Schema.TaggedStruct("speech", { state: SpeechState }),
]);
export type VoiceStateEvent = typeof VoiceStateEvent.Type;

const VoiceRequestError = Schema.Union([
  DictationError,
  SpeechError,
  EnvironmentAuthorizationError,
]);

const WsVoiceRequestRpc = Rpc.make(DICTATION_WS_METHODS.voiceRequest, {
  payload: VoiceRequestPayload,
  success: VoiceRequestResult,
  error: VoiceRequestError,
});

const WsSubscribeVoiceStateRpc = Rpc.make(DICTATION_WS_METHODS.subscribeVoiceState, {
  payload: Schema.Struct({ topic: VoiceStateTopic }),
  success: VoiceStateEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const DictationRpcs = [WsVoiceRequestRpc, WsSubscribeVoiceStateRpc] as const;

/**
 * Client-guarded scopes (the subscriptions are not guarded client-side). Every former
 * operation was guarded by operate scope, so the single request method is too.
 */
export const DICTATION_CLIENT_GUARDED_RPC_SCOPES = {
  [DICTATION_WS_METHODS.voiceRequest]: AuthOrchestrationOperateScope,
} as const;

/** Scopes the server requires for every dictation and speech method. */
export const DICTATION_RPC_REQUIRED_SCOPES = {
  ...DICTATION_CLIENT_GUARDED_RPC_SCOPES,
  [DICTATION_WS_METHODS.subscribeVoiceState]: AuthOrchestrationReadScope,
} as const;
