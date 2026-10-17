/**
 * Dictation and speech RPC definitions, kept apart from `rpc.ts` and spread into
 * `WS_METHODS` / `WsRpcGroup` there. Speech synthesis shares the dictation runtime and
 * worker, so its methods ride the same method/scope maps instead of a second spread.
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
  dictationInstall: "dictation.install",
  dictationRemove: "dictation.remove",
  dictationStart: "dictation.start",
  dictationWarm: "dictation.warm",
  dictationAppend: "dictation.append",
  dictationFinish: "dictation.finish",
  dictationCancel: "dictation.cancel",
  subscribeDictationState: "subscribeDictationState",
  speechInstall: "speech.install",
  speechRemove: "speech.remove",
  speechWarm: "speech.warm",
  speechSynthesize: "speech.synthesize",
  subscribeSpeechState: "subscribeSpeechState",
} as const;

const DictationRpcError = Schema.Union([DictationError, EnvironmentAuthorizationError]);

const WsDictationInstallRpc = Rpc.make(DICTATION_WS_METHODS.dictationInstall, {
  payload: DictationInstallInput,
  error: DictationRpcError,
});

const WsDictationRemoveRpc = Rpc.make(DICTATION_WS_METHODS.dictationRemove, {
  payload: DictationRemoveInput,
  error: DictationRpcError,
});

const WsDictationStartRpc = Rpc.make(DICTATION_WS_METHODS.dictationStart, {
  payload: Schema.Struct({}),
  success: DictationStartResult,
  error: DictationRpcError,
});

/** Starts loading the speech model ahead of a likely dictation; a no-op when dictation is off. */
const WsDictationWarmRpc = Rpc.make(DICTATION_WS_METHODS.dictationWarm, {
  payload: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsDictationAppendRpc = Rpc.make(DICTATION_WS_METHODS.dictationAppend, {
  payload: DictationAppendInput,
  error: DictationRpcError,
});

const WsDictationFinishRpc = Rpc.make(DICTATION_WS_METHODS.dictationFinish, {
  payload: DictationFinishInput,
  success: DictationFinishResult,
  error: DictationRpcError,
});

const WsDictationCancelRpc = Rpc.make(DICTATION_WS_METHODS.dictationCancel, {
  payload: DictationCancelInput,
  error: DictationRpcError,
});

const WsSubscribeDictationStateRpc = Rpc.make(DICTATION_WS_METHODS.subscribeDictationState, {
  payload: Schema.Struct({}),
  success: DictationState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const SpeechRpcError = Schema.Union([SpeechError, EnvironmentAuthorizationError]);

/** Starts or retries the Kokoro model download; returns before it completes. */
const WsSpeechInstallRpc = Rpc.make(DICTATION_WS_METHODS.speechInstall, {
  payload: Schema.Struct({}),
  error: SpeechRpcError,
});

/** Reclaims the installed Kokoro model, unloading it first. */
const WsSpeechRemoveRpc = Rpc.make(DICTATION_WS_METHODS.speechRemove, {
  payload: Schema.Struct({}),
  error: SpeechRpcError,
});

/** Loads the model ahead of a likely synthesis; a no-op when speech is off or uninstalled. */
const WsSpeechWarmRpc = Rpc.make(DICTATION_WS_METHODS.speechWarm, {
  payload: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsSpeechSynthesizeRpc = Rpc.make(DICTATION_WS_METHODS.speechSynthesize, {
  payload: SpeechSynthesizeInput,
  success: SpeechSynthesizeResult,
  error: SpeechRpcError,
});

const WsSubscribeSpeechStateRpc = Rpc.make(DICTATION_WS_METHODS.subscribeSpeechState, {
  payload: Schema.Struct({}),
  success: SpeechState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const DictationRpcs = [
  WsDictationInstallRpc,
  WsDictationRemoveRpc,
  WsDictationStartRpc,
  WsDictationWarmRpc,
  WsDictationAppendRpc,
  WsDictationFinishRpc,
  WsDictationCancelRpc,
  WsSubscribeDictationStateRpc,
  WsSpeechInstallRpc,
  WsSpeechRemoveRpc,
  WsSpeechWarmRpc,
  WsSpeechSynthesizeRpc,
  WsSubscribeSpeechStateRpc,
] as const;

/** Client-guarded scopes (the subscriptions are not guarded client-side). */
export const DICTATION_CLIENT_GUARDED_RPC_SCOPES = {
  [DICTATION_WS_METHODS.dictationInstall]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationRemove]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationStart]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationWarm]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationAppend]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationFinish]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationCancel]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.speechInstall]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.speechRemove]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.speechWarm]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.speechSynthesize]: AuthOrchestrationOperateScope,
} as const;

/** Scopes the server requires for every dictation and speech method. */
export const DICTATION_RPC_REQUIRED_SCOPES = {
  ...DICTATION_CLIENT_GUARDED_RPC_SCOPES,
  [DICTATION_WS_METHODS.subscribeDictationState]: AuthOrchestrationReadScope,
  [DICTATION_WS_METHODS.subscribeSpeechState]: AuthOrchestrationReadScope,
} as const;
