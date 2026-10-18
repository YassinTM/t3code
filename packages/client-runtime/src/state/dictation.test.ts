import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  DictationSessionId,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
  type DictationState,
  type SpeechState,
  type VoiceRequestPayload,
  type VoiceRequestResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createDictationEnvironmentAtoms, resolveDictationEnvironment } from "./dictation.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const ENVIRONMENT = EnvironmentId.make("voice-environment");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT,
  label: "Voice environment",
  httpBaseUrl: "https://voice.example.test",
  wsBaseUrl: "wss://voice.example.test",
});

const DICTATION_STATE: DictationState = {
  supported: true,
  settings: { engine: "local", localModel: "parakeet-v3", language: "auto" },
  runtime: { _tag: "installed", sizeBytes: 1 },
  models: [],
  loadedModel: null,
  ready: true,
};

const SPEECH_STATE: SpeechState = {
  supported: true,
  settings: { enabled: true, voice: 0, speed: 1 },
  install: { _tag: "installed", sizeBytes: 1 },
  loaded: true,
};

const grant = (): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationOperateScope],
});

/** The tagged success the stub environment answers with, per payload tag. */
const defaultRespond = (input: VoiceRequestPayload): Effect.Effect<VoiceRequestResult> => {
  switch (input._tag) {
    case "dictation.start":
      return Effect.succeed({
        _tag: "dictation.started",
        sessionId: DictationSessionId.make("session-1"),
      });
    case "dictation.finish":
      return Effect.succeed({ _tag: "dictation.finished", text: "hello", locale: "en" });
    default:
      return Effect.succeed({ _tag: "none" });
  }
};

const makeHarness = Effect.fn("TestVoiceRpc.makeHarness")(function* (
  respond: (input: VoiceRequestPayload) => Effect.Effect<VoiceRequestResult> = defaultRespond,
) {
  const requests: Array<VoiceRequestPayload> = [];
  const subscriptions: Array<{ readonly topic: string }> = [];
  const session = {
    client: {
      [WS_METHODS.voiceRequest]: (input: VoiceRequestPayload) =>
        Effect.suspend(() => {
          requests.push(input);
          return respond(input);
        }),
      // The speech push comes first, so a broken topic filter surfaces before the dictation one.
      [WS_METHODS.subscribeVoiceState]: (input: { readonly topic: string }) => {
        subscriptions.push(input);
        return Stream.make(
          { _tag: "speech", state: SPEECH_STATE },
          { _tag: "dictation", state: DICTATION_STATE },
        );
      },
    },
  } as unknown as RpcSession;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  return {
    requests,
    subscriptions,
    runtime: Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
  };
});

/** One registry per test, with the operate grant the shared method now requires. */
const makeRegistry = () => {
  const registry = AtomRegistry.make();
  registry.mount(sessions(ENVIRONMENT));
  registry.set(sessions(ENVIRONMENT), AsyncResult.success(grant()));
  return registry;
};

const successValue = <A, E>(result: AsyncResult.AsyncResult<A, E>): A => {
  if (!AsyncResult.isSuccess(result)) {
    throw new Error(`Expected a successful command result, got ${result._tag}.`);
  }
  return result.value;
};

describe("dictation command wrappers", () => {
  it.effect("builds the shared tagged payload for every former command", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const atoms = createDictationEnvironmentAtoms(harness.runtime);
      const registry = makeRegistry();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

      yield* Effect.promise(() =>
        atoms.install.run(registry, {
          environmentId: ENVIRONMENT,
          input: { model: "whisper-turbo" },
        }),
      );
      yield* Effect.promise(() =>
        atoms.remove.run(registry, {
          environmentId: ENVIRONMENT,
          input: { model: "moonshine-base" },
        }),
      );
      yield* Effect.promise(() =>
        atoms.start.run(registry, { environmentId: ENVIRONMENT, input: {} }),
      );
      yield* Effect.promise(() =>
        atoms.warm.run(registry, { environmentId: ENVIRONMENT, input: {} }),
      );
      yield* Effect.promise(() =>
        atoms.append.run(registry, {
          environmentId: ENVIRONMENT,
          input: { sessionId: DictationSessionId.make("session-1"), seq: 2, pcm: "AA==" },
        }),
      );
      yield* Effect.promise(() =>
        atoms.finish.run(registry, {
          environmentId: ENVIRONMENT,
          input: { sessionId: DictationSessionId.make("session-1"), chunkCount: 3 },
        }),
      );
      yield* Effect.promise(() =>
        atoms.cancel.run(registry, {
          environmentId: ENVIRONMENT,
          input: { sessionId: DictationSessionId.make("session-1") },
        }),
      );

      expect(harness.requests).toEqual([
        { _tag: "dictation.install", model: "whisper-turbo" },
        { _tag: "dictation.remove", model: "moonshine-base" },
        { _tag: "dictation.start" },
        { _tag: "dictation.warm" },
        { _tag: "dictation.append", sessionId: "session-1", seq: 2, pcm: "AA==" },
        { _tag: "dictation.finish", sessionId: "session-1", chunkCount: 3 },
        { _tag: "dictation.cancel", sessionId: "session-1" },
      ]);
    }),
  );

  it.effect("unwraps the tagged successes into the shapes callers already use", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const atoms = createDictationEnvironmentAtoms(harness.runtime);
      const registry = makeRegistry();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

      const started = yield* Effect.promise(() =>
        atoms.start.run(registry, { environmentId: ENVIRONMENT, input: {} }),
      );
      const finished = yield* Effect.promise(() =>
        atoms.finish.run(registry, {
          environmentId: ENVIRONMENT,
          input: { sessionId: DictationSessionId.make("session-1"), chunkCount: 1 },
        }),
      );
      const warmed = yield* Effect.promise(() =>
        atoms.warm.run(registry, { environmentId: ENVIRONMENT, input: {} }),
      );

      expect(successValue(started)).toEqual({ sessionId: "session-1" });
      expect(successValue(finished)).toEqual({ text: "hello", locale: "en" });
      expect(successValue(warmed)).toBeUndefined();
    }),
  );

  it.effect("fails the command when the environment answers with another tag", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.succeed({ _tag: "none" }));
      const atoms = createDictationEnvironmentAtoms(harness.runtime);
      const registry = makeRegistry();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

      const result = yield* Effect.promise(() =>
        atoms.start.run(registry, { environmentId: ENVIRONMENT, input: {} }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("subscribes to the dictation topic and unwraps the state push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const atoms = createDictationEnvironmentAtoms(harness.runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

        const atom = atoms.state({ environmentId: ENVIRONMENT, input: {} });
        const sawState = yield* Deferred.make<DictationState>();
        const unsubscribe = registry.subscribe(
          atom,
          (result) => {
            if (AsyncResult.isSuccess(result)) {
              Deferred.doneUnsafe(sawState, Exit.succeed(result.value));
            }
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));

        expect(yield* Deferred.await(sawState)).toEqual(DICTATION_STATE);
        expect(harness.subscriptions).toEqual([{ topic: "dictation" }]);
      }),
    ),
  );
});

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const studio = EnvironmentId.make("studio");

describe("resolveDictationEnvironment", () => {
  it("uses the chosen environment while it is ready", () => {
    expect(
      resolveDictationEnvironment({
        chosen: studio,
        draftEnvironmentId: server,
        primaryEnvironmentId: laptop,
        ready: [laptop, server, studio],
      }),
    ).toBe(studio);
  });

  it("falls back to the draft's environment, then the primary, then any ready one", () => {
    const resolve = (ready: ReadonlyArray<EnvironmentId>) =>
      resolveDictationEnvironment({
        chosen: studio,
        draftEnvironmentId: server,
        primaryEnvironmentId: laptop,
        ready,
      });
    expect(resolve([laptop, server])).toBe(server);
    expect(resolve([laptop])).toBe(laptop);
    expect(
      resolveDictationEnvironment({
        chosen: null,
        draftEnvironmentId: server,
        primaryEnvironmentId: null,
        ready: [studio],
      }),
    ).toBe(studio);
  });

  it("returns null when no environment is ready", () => {
    expect(
      resolveDictationEnvironment({
        chosen: laptop,
        draftEnvironmentId: server,
        primaryEnvironmentId: laptop,
        ready: [],
      }),
    ).toBeNull();
  });
});
