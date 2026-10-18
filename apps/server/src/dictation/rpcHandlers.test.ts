import { describe, expect, it } from "@effect/vitest";
import {
  DictationError,
  DictationSessionId,
  WS_METHODS,
  WsRpcGroup,
  type DictationState,
  type SpeechState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as SpeechSynthesis from "../speech/SpeechSynthesis.ts";
import * as Dictation from "./Dictation.ts";
import { makeDictationRpcHandlers } from "./rpcHandlers.ts";

const DICTATION_STATE: DictationState = {
  supported: true,
  settings: { engine: "local", localModel: "whisper-turbo", language: "auto" },
  runtime: { _tag: "installed", sizeBytes: 1 },
  models: [],
  loadedModel: null,
  ready: true,
};

const SPEECH_STATE: SpeechState = {
  supported: true,
  settings: { enabled: true, voice: 2, speed: 1 },
  install: { _tag: "installed", sizeBytes: 1 },
  loaded: true,
};

interface Fixture {
  readonly calls: Array<string>;
  readonly dictation: Dictation.Dictation["Service"];
  readonly speech: SpeechSynthesis.SpeechSynthesis["Service"];
  readonly layer: Layer.Layer<Dictation.Dictation | SpeechSynthesis.SpeechSynthesis>;
}

/** Both services record the call they were asked to run, in order. */
const makeFixture = (): Fixture => {
  const calls: Array<string> = [];
  const record = (call: string): void => {
    calls.push(call);
  };
  const dictation: Dictation.Dictation["Service"] = {
    state: Effect.succeed(DICTATION_STATE),
    stateStream: Stream.make(DICTATION_STATE),
    install: (input) => Effect.sync(() => record(`dictation.install:${input.model}`)),
    remove: (input) => Effect.sync(() => record(`dictation.remove:${input.model}`)),
    start: Effect.sync(() => {
      record("dictation.start");
      return { sessionId: DictationSessionId.make("session-1") };
    }),
    warm: Effect.sync(() => record("dictation.warm")),
    append: (input) => Effect.sync(() => record(`dictation.append:${input.seq}:${input.pcm}`)),
    finish: (input) =>
      Effect.sync(() => {
        record(`dictation.finish:${input.chunkCount}`);
        return { text: "hello", locale: "en" };
      }),
    cancel: (input) => Effect.sync(() => record(`dictation.cancel:${input.sessionId}`)),
  };
  const speech: SpeechSynthesis.SpeechSynthesis["Service"] = {
    state: Effect.succeed(SPEECH_STATE),
    stateStream: Stream.make(SPEECH_STATE),
    install: Effect.sync(() => record("speech.install")),
    remove: Effect.sync(() => record("speech.remove")),
    warm: Effect.sync(() => record("speech.warm")),
    synthesize: (input) =>
      Effect.sync(() => {
        record(`speech.synthesize:${input.text}`);
        return { sampleRate: 24_000, pcm16: "AA==", durationMs: 5 };
      }),
  };
  return {
    calls,
    dictation,
    speech,
    layer: Layer.mergeAll(
      Layer.succeed(Dictation.Dictation, dictation),
      Layer.succeed(SpeechSynthesis.SpeechSynthesis, speech),
    ),
  };
};

describe("voice.request dispatcher", () => {
  it.effect("routes every dictation tag to its service method and tags the result", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const voiceRequest = (yield* makeDictationRpcHandlers)[WS_METHODS.voiceRequest];

      expect(yield* voiceRequest({ _tag: "dictation.install", model: "parakeet-v3" })).toEqual({
        _tag: "none",
      });
      expect(yield* voiceRequest({ _tag: "dictation.remove", model: "moonshine-base" })).toEqual({
        _tag: "none",
      });
      expect(yield* voiceRequest({ _tag: "dictation.start" })).toEqual({
        _tag: "dictation.started",
        sessionId: "session-1",
      });
      expect(yield* voiceRequest({ _tag: "dictation.warm" })).toEqual({ _tag: "none" });
      expect(
        yield* voiceRequest({
          _tag: "dictation.append",
          sessionId: DictationSessionId.make("session-1"),
          seq: 3,
          pcm: "AA==",
        }),
      ).toEqual({ _tag: "none" });
      expect(
        yield* voiceRequest({
          _tag: "dictation.finish",
          sessionId: DictationSessionId.make("session-1"),
          chunkCount: 4,
        }),
      ).toEqual({ _tag: "dictation.finished", text: "hello", locale: "en" });
      expect(
        yield* voiceRequest({
          _tag: "dictation.cancel",
          sessionId: DictationSessionId.make("session-1"),
        }),
      ).toEqual({
        _tag: "none",
      });

      expect(fixture.calls).toEqual([
        "dictation.install:parakeet-v3",
        "dictation.remove:moonshine-base",
        "dictation.start",
        "dictation.warm",
        "dictation.append:3:AA==",
        "dictation.finish:4",
        "dictation.cancel:session-1",
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("routes every speech tag and tags the synthesized result", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const voiceRequest = (yield* makeDictationRpcHandlers)[WS_METHODS.voiceRequest];

      expect(yield* voiceRequest({ _tag: "speech.install" })).toEqual({ _tag: "none" });
      expect(yield* voiceRequest({ _tag: "speech.remove" })).toEqual({ _tag: "none" });
      expect(yield* voiceRequest({ _tag: "speech.warm" })).toEqual({ _tag: "none" });
      expect(
        yield* voiceRequest({ _tag: "speech.synthesize", text: "hello", voice: 3, speed: 1.5 }),
      ).toEqual({ _tag: "speech.synthesized", sampleRate: 24_000, pcm16: "AA==", durationMs: 5 });

      expect(fixture.calls).toEqual([
        "speech.install",
        "speech.remove",
        "speech.warm",
        "speech.synthesize:hello",
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("passes a service failure through unchanged", () => {
    const fixture = makeFixture();
    const dictation: Dictation.Dictation["Service"] = {
      ...fixture.dictation,
      start: Effect.fail(new DictationError({ reason: "disabled", message: "Dictation is off." })),
    };
    return Effect.gen(function* () {
      const voiceRequest = (yield* makeDictationRpcHandlers)[WS_METHODS.voiceRequest];
      const failure = yield* Effect.flip(voiceRequest({ _tag: "dictation.start" }));

      expect(failure).toMatchObject({ _tag: "DictationError", reason: "disabled" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Dictation.Dictation, dictation),
          Layer.succeed(SpeechSynthesis.SpeechSynthesis, fixture.speech),
        ),
      ),
    );
  });

  it.effect("routes subscribeVoiceState to the stream its topic names", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const subscribe = (yield* makeDictationRpcHandlers)[WS_METHODS.subscribeVoiceState];

      expect(yield* Stream.runCollect(subscribe({ topic: "dictation" }))).toEqual([
        { _tag: "dictation", state: DICTATION_STATE },
      ]);
      expect(yield* Stream.runCollect(subscribe({ topic: "speech" }))).toEqual([
        { _tag: "speech", state: SPEECH_STATE },
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it("rejects an unknown voice tag at the RPC boundary", () => {
    const rpc = WsRpcGroup.requests.get(WS_METHODS.voiceRequest);
    if (rpc === undefined) throw new Error("voice.request is not registered");
    const decode = Schema.decodeUnknownExit(rpc.payloadSchema);

    expect(Exit.isFailure(decode({ _tag: "dictation.unknown" }))).toBe(true);
    expect(Exit.isFailure(decode({ _tag: "dictation.finish", sessionId: "session-1" }))).toBe(true);
    expect(Exit.isSuccess(decode({ _tag: "dictation.start" }))).toBe(true);
  });
});
