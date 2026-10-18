import {
  type DictationAppendInput,
  type DictationCancelInput,
  type DictationFinishInput,
  type DictationFinishResult,
  type DictationInstallInput,
  type DictationRemoveInput,
  type DictationStartResult,
  type EnvironmentId,
  type SpeechSynthesizeInput,
  type SpeechSynthesizeResult,
  type VoiceRequestPayload,
  type VoiceRequestResult,
  type VoiceStateEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  mapAtomCommandResult,
  type AtomCommand,
} from "./runtime.ts";

/** The one method every former dictation command (and speech command) now rides. */
const VOICE_REQUEST_LABEL = "environment-data:voice:request";

/** Rejects a success the environment did not answer with the tag this command expects. */
function expectVoiceResult<Tag extends VoiceRequestResult["_tag"]>(
  result: VoiceRequestResult,
  tag: Tag,
): Extract<VoiceRequestResult, { readonly _tag: Tag }> {
  if (result._tag !== tag) {
    throw new Error(`Unexpected voice response: expected ${tag}, got ${result._tag}.`);
  }
  return result as Extract<VoiceRequestResult, { readonly _tag: Tag }>;
}

/** Every operation that used to answer with nothing now answers with the `none` tag. */
const unwrapNone = (result: VoiceRequestResult): undefined => {
  expectVoiceResult(result, "none");
  return undefined;
};

/**
 * Answers one former dictation command through the shared `voice.request` method: build the
 * tagged payload from the caller's input, then unwrap the tagged success so callers keep
 * receiving exactly what they used to.
 */
function createVoiceRequestCommand<Input, A, E>(options: {
  readonly label: string;
  readonly request: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: VoiceRequestPayload },
    VoiceRequestResult,
    E
  >;
  readonly build: (input: Input) => VoiceRequestPayload;
  readonly unwrap: (result: VoiceRequestResult) => A;
}): AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E> {
  return {
    label: options.label,
    run: async (registry, target) => {
      try {
        const result = await options.request.run(registry, {
          environmentId: target.environmentId,
          input: options.build(target.input),
        });
        return mapAtomCommandResult(result, options.unwrap);
      } catch (defect) {
        // An unexpected tag is a defect, like every other atom command boundary.
        return AsyncResult.failure(Cause.die(defect));
      }
    },
  };
}

/**
 * Dictation atoms for every environment, all riding the single `voice.request` RPC. Install
 * and remove run one at a time per environment; session commands run in parallel because the
 * server orders appended chunks by `seq`.
 */
export function createDictationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  // The serial lane belongs to the command, not the method, so install/remove share one
  // wrapper while the session commands use another over the same tag.
  const serialRequest = createEnvironmentRpcCommand(runtime, {
    label: VOICE_REQUEST_LABEL,
    tag: WS_METHODS.voiceRequest,
    scheduler,
    concurrency,
  });
  const parallelRequest = createEnvironmentRpcCommand(runtime, {
    label: VOICE_REQUEST_LABEL,
    tag: WS_METHODS.voiceRequest,
  });

  /** A caller-facing command built from one shared request wrapper. */
  const command = <Input, A>(
    label: string,
    build: (input: Input) => VoiceRequestPayload,
    unwrap: (result: VoiceRequestResult) => A,
    request: typeof parallelRequest = parallelRequest,
  ) => ({
    ...createVoiceRequestCommand({ label, request, build, unwrap }),
    requiredScopes: serialRequest.requiredScopes,
    permissionAtom: serialRequest.permissionAtom,
  });

  const voiceState = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:dictation:state",
    tag: WS_METHODS.subscribeVoiceState,
    transform: (stream) =>
      stream.pipe(
        Stream.filter(
          (event): event is Extract<VoiceStateEvent, { readonly _tag: "dictation" }> =>
            event._tag === "dictation",
        ),
        Stream.map((event) => event.state),
      ),
  });

  return {
    /**
     * Server-pushed engine settings, install progress, and readiness for one environment.
     * Callers keep passing `{}`: the topic is fixed here.
     */
    state: (target: { readonly environmentId: EnvironmentId; readonly input: {} }) =>
      voiceState({ environmentId: target.environmentId, input: { topic: "dictation" } }),
    install: command(
      "environment-data:dictation:install",
      (input: DictationInstallInput): VoiceRequestPayload => ({
        _tag: "dictation.install",
        model: input.model,
      }),
      unwrapNone,
      serialRequest,
    ),
    remove: command(
      "environment-data:dictation:remove",
      (input: DictationRemoveInput): VoiceRequestPayload => ({
        _tag: "dictation.remove",
        model: input.model,
      }),
      unwrapNone,
      serialRequest,
    ),
    /** Opens a session and starts loading the model, so warm-up overlaps speaking. */
    start: command(
      "environment-data:dictation:start",
      (): VoiceRequestPayload => ({ _tag: "dictation.start" }),
      (result): DictationStartResult => {
        const started = expectVoiceResult(result, "dictation.started");
        return { sessionId: started.sessionId };
      },
    ),
    /** Loads the speech model ahead of a likely dictation, e.g. on composer focus. */
    warm: command(
      "environment-data:dictation:warm",
      (): VoiceRequestPayload => ({ _tag: "dictation.warm" }),
      unwrapNone,
    ),
    append: command(
      "environment-data:dictation:append",
      (input: DictationAppendInput): VoiceRequestPayload => ({
        _tag: "dictation.append",
        sessionId: input.sessionId,
        seq: input.seq,
        pcm: input.pcm,
      }),
      unwrapNone,
    ),
    finish: command(
      "environment-data:dictation:finish",
      (input: DictationFinishInput): VoiceRequestPayload => ({
        _tag: "dictation.finish",
        sessionId: input.sessionId,
        chunkCount: input.chunkCount,
      }),
      (result): DictationFinishResult => {
        const finished = expectVoiceResult(result, "dictation.finished");
        return { text: finished.text, locale: finished.locale };
      },
    ),
    cancel: command(
      "environment-data:dictation:cancel",
      (input: DictationCancelInput): VoiceRequestPayload => ({
        _tag: "dictation.cancel",
        sessionId: input.sessionId,
      }),
      unwrapNone,
    ),
  };
}

/**
 * Speech atoms for every environment, riding the same `voice.request` method as dictation.
 * Install and remove run one at a time per environment, like dictation's; warm-up and
 * synthesis can run concurrently because the server owns its ordering and serializes the
 * native work itself.
 */
export function createSpeechEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  const serialRequest = createEnvironmentRpcCommand(runtime, {
    label: VOICE_REQUEST_LABEL,
    tag: WS_METHODS.voiceRequest,
    scheduler,
    concurrency,
  });
  const parallelRequest = createEnvironmentRpcCommand(runtime, {
    label: VOICE_REQUEST_LABEL,
    tag: WS_METHODS.voiceRequest,
  });

  /** A caller-facing command built from one shared request wrapper. */
  const command = <Input, A>(
    label: string,
    build: (input: Input) => VoiceRequestPayload,
    unwrap: (result: VoiceRequestResult) => A,
    request: typeof parallelRequest = parallelRequest,
  ) => ({
    ...createVoiceRequestCommand({ label, request, build, unwrap }),
    requiredScopes: serialRequest.requiredScopes,
    permissionAtom: serialRequest.permissionAtom,
  });

  const voiceState = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:speech:state",
    tag: WS_METHODS.subscribeVoiceState,
    transform: (stream) =>
      stream.pipe(
        Stream.filter(
          (event): event is Extract<VoiceStateEvent, { readonly _tag: "speech" }> =>
            event._tag === "speech",
        ),
        Stream.map((event) => event.state),
      ),
  });

  return {
    /**
     * Server-pushed speech settings, install progress, and readiness for one environment.
     * Callers keep passing `{}`: the topic is fixed here.
     */
    state: (target: { readonly environmentId: EnvironmentId; readonly input: {} }) =>
      voiceState({ environmentId: target.environmentId, input: { topic: "speech" } }),
    /** Starts or retries the Kokoro model download; returns before it completes. */
    install: command(
      "environment-data:speech:install",
      (): VoiceRequestPayload => ({ _tag: "speech.install" }),
      unwrapNone,
      serialRequest,
    ),
    /** Deletes the downloaded model. */
    remove: command(
      "environment-data:speech:remove",
      (): VoiceRequestPayload => ({ _tag: "speech.remove" }),
      unwrapNone,
      serialRequest,
    ),
    /** Loads the model ahead of a likely synthesis; a no-op when speech is off or uninstalled. */
    warm: command(
      "environment-data:speech:warm",
      (): VoiceRequestPayload => ({ _tag: "speech.warm" }),
      unwrapNone,
    ),
    /** Renders one 1-1000 character chunk to PCM on the environment. */
    synthesize: command(
      "environment-data:speech:synthesize",
      (input: SpeechSynthesizeInput): VoiceRequestPayload => ({
        _tag: "speech.synthesize",
        text: input.text,
        ...(input.voice === undefined ? {} : { voice: input.voice }),
        ...(input.speed === undefined ? {} : { speed: input.speed }),
      }),
      (result): SpeechSynthesizeResult => {
        const synthesized = expectVoiceResult(result, "speech.synthesized");
        return {
          sampleRate: synthesized.sampleRate,
          pcm16: synthesized.pcm16,
          durationMs: synthesized.durationMs,
        };
      },
    ),
  };
}

/**
 * Picks the environment that speaks this device's assistant replies. Speech shares the dictation
 * machine, so a pinned environment wins while it can speak; otherwise the environment that owns
 * the thread, then the primary, then any connected environment that can speak.
 */
export function resolveSpeechEnvironment(input: {
  readonly chosen: EnvironmentId | null;
  readonly draftEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly ready: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  return resolveDictationEnvironment(input);
}

/**
 * Picks the environment that transcribes this device's dictation. `ready`
 * lists connected environments whose dictation is ready, in display order.
 * A chosen environment wins while it is ready; otherwise the environment that
 * owns the draft, then the primary, then any ready environment.
 */
export function resolveDictationEnvironment(input: {
  readonly chosen: EnvironmentId | null;
  readonly draftEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly ready: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  const candidates = [input.chosen, input.draftEnvironmentId, input.primaryEnvironmentId];
  return (
    candidates.find(
      (environmentId) => environmentId !== null && input.ready.includes(environmentId),
    ) ??
    input.ready[0] ??
    null
  );
}
