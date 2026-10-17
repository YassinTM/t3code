/**
 * Dictation RPC definitions, kept apart from `rpc.ts` and spread into
 * `WS_METHODS` / `WsRpcGroup` there.
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

export const DictationRpcs = [
  WsDictationInstallRpc,
  WsDictationRemoveRpc,
  WsDictationStartRpc,
  WsDictationWarmRpc,
  WsDictationAppendRpc,
  WsDictationFinishRpc,
  WsDictationCancelRpc,
  WsSubscribeDictationStateRpc,
] as const;

/** Client-guarded scopes (the subscription is not guarded client-side). */
export const DICTATION_CLIENT_GUARDED_RPC_SCOPES = {
  [DICTATION_WS_METHODS.dictationInstall]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationRemove]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationStart]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationWarm]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationAppend]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationFinish]: AuthOrchestrationOperateScope,
  [DICTATION_WS_METHODS.dictationCancel]: AuthOrchestrationOperateScope,
} as const;

/** Scopes the server requires for every dictation method. */
export const DICTATION_RPC_REQUIRED_SCOPES = {
  ...DICTATION_CLIENT_GUARDED_RPC_SCOPES,
  [DICTATION_WS_METHODS.subscribeDictationState]: AuthOrchestrationReadScope,
} as const;
