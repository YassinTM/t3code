import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";
import {
  DICTATION_CLIENT_GUARDED_RPC_SCOPES,
  DICTATION_RPC_REQUIRED_SCOPES,
  DICTATION_WS_METHODS,
  VoiceRequestPayload,
  VoiceRequestResult,
  VoiceStateEvent,
} from "./dictationRpc.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodePayload = Schema.decodeUnknownExit(VoiceRequestPayload);
const decodeResult = Schema.decodeUnknownExit(VoiceRequestResult);

describe("voice RPC contracts", () => {
  it("costs the fork exactly two WebSocket methods", () => {
    expect(DICTATION_WS_METHODS).toEqual({
      voiceRequest: "voice.request",
      subscribeVoiceState: "subscribeVoiceState",
    });
    expect(WS_METHODS.voiceRequest).toBe("voice.request");
    expect(WS_METHODS.subscribeVoiceState).toBe("subscribeVoiceState");
    const group = WsRpcGroup.requests;
    expect(group.has(DICTATION_WS_METHODS.voiceRequest)).toBe(true);
    expect(group.has(DICTATION_WS_METHODS.subscribeVoiceState)).toBe(true);
  });

  it("decodes every former operation as a tagged payload carrying its own fields", () => {
    const payloads = [
      { _tag: "dictation.install", model: "parakeet-v3" },
      { _tag: "dictation.remove", model: "whisper-turbo" },
      { _tag: "dictation.start" },
      { _tag: "dictation.warm" },
      { _tag: "dictation.append", sessionId: "session-1", seq: 0, pcm: "AA==" },
      { _tag: "dictation.finish", sessionId: "session-1", chunkCount: 1 },
      { _tag: "dictation.cancel", sessionId: "session-1" },
      { _tag: "speech.install" },
      { _tag: "speech.remove" },
      { _tag: "speech.warm" },
      { _tag: "speech.synthesize", text: "hello" },
    ] as const;

    for (const payload of payloads) {
      expect(Exit.isSuccess(decodePayload(payload))).toBe(true);
    }
  });

  it("rejects an unknown tag and a payload missing its fields", () => {
    expect(Exit.isFailure(decodePayload({ _tag: "dictation.unknown" }))).toBe(true);
    expect(
      Exit.isFailure(decodePayload({ _tag: "dictation.append", sessionId: "session-1" })),
    ).toBe(true);
    expect(Exit.isFailure(decodePayload({ _tag: "dictation.install" }))).toBe(true);
  });

  it("keeps the optional speech synthesis fields optional", () => {
    expect(
      Exit.isSuccess(
        decodePayload({ _tag: "speech.synthesize", text: "hi", voice: 3, speed: 1.5 }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodePayload({ _tag: "speech.synthesize" }))).toBe(true);
  });

  it("decodes one tagged success per former result shape", () => {
    for (const result of [
      { _tag: "none" },
      { _tag: "dictation.started", sessionId: "session-1" },
      { _tag: "dictation.finished", text: "hello", locale: "en" },
      { _tag: "speech.synthesized", sampleRate: 24_000, pcm16: "AA==", durationMs: 12 },
    ]) {
      expect(Exit.isSuccess(decodeResult(result))).toBe(true);
    }
    expect(Exit.isFailure(decodeResult({ _tag: "dictation.started" }))).toBe(true);
    expect(Exit.isFailure(decodeResult({ _tag: "dictation.finished", text: "hello" }))).toBe(true);
    expect(Exit.isFailure(decodeResult({ _tag: "unknown" }))).toBe(true);
  });

  it("tags voice state pushes so both streams share one subscription", () => {
    const event = Schema.decodeUnknownExit(VoiceStateEvent);
    expect(
      Exit.isSuccess(
        event({
          _tag: "dictation",
          state: {
            supported: true,
            settings: { engine: "off", localModel: "parakeet-v3", language: "auto" },
            runtime: { _tag: "not-installed" },
            models: [],
            loadedModel: null,
            ready: false,
          },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        event({
          _tag: "speech",
          state: {
            supported: true,
            settings: { enabled: false, voice: 0, speed: 1 },
            install: { _tag: "not-installed" },
            loaded: false,
          },
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(event({ _tag: "voice", state: {} }))).toBe(true);
  });

  it("guards the request with operate scope and the subscription with read scope", () => {
    expect(DICTATION_CLIENT_GUARDED_RPC_SCOPES).toEqual({
      [WS_METHODS.voiceRequest]: AuthOrchestrationOperateScope,
    });
    expect(DICTATION_RPC_REQUIRED_SCOPES).toEqual({
      [WS_METHODS.voiceRequest]: AuthOrchestrationOperateScope,
      [WS_METHODS.subscribeVoiceState]: AuthOrchestrationReadScope,
    });
  });
});
