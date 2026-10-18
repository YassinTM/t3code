import { useAtomValue } from "@effect/atom-react";
import {
  createSpeechEnvironmentAtoms,
  resolveSpeechEnvironment,
} from "@t3tools/client-runtime/state/dictation";
import type { ClientSettings, EnvironmentId, SpeechState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useClientSettings } from "../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentSummaries } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";

export const speechEnvironment = createSpeechEnvironmentAtoms(connectionAtomRuntime);

/** Kokoro's pinned release archive, so settings can show a size before a download starts. */
export const SPEECH_MODEL_BYTES = 319_625_534;

/** True when this environment can speak right now: supported, enabled, and downloaded. */
export function speechStateReady(state: SpeechState | null): boolean {
  if (state === null || !state.supported) return false;
  return state.settings.enabled && state.install._tag === "installed";
}

/**
 * The latest speech state for one environment. While the subscription reconnects it keeps the
 * last state it saw, so settings rows and the read-aloud button do not blank out.
 */
const lastSpeechStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): SpeechState | null => {
    const current = AsyncResult.value(get(speechEnvironment.state({ environmentId, input: {} })));
    return Option.isSome(current)
      ? current.value
      : Option.getOrNull(get.self<SpeechState | null>());
  }).pipe(Atom.withLabel(`speech:last-state:${environmentId}`)),
);

const NO_SPEECH_STATE = Atom.make<SpeechState | null>(null);

/** Speech state for one environment; null until it first loads or when the server lacks speech. */
export function useSpeechState(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : speechEnvironment.state({ environmentId, input: {} }),
  );
  const state = useAtomValue(
    environmentId === null ? NO_SPEECH_STATE : lastSpeechStateAtom(environmentId),
  );
  return { state, error: query.error };
}

/**
 * Connected environments that can speak right now, in display order. Keeps the previous array
 * while membership is unchanged, so install progress on one environment does not re-render read
 * surfaces everywhere.
 */
const readySpeechEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.connectedEnvironmentIdsAtom).filter((environmentId) =>
    speechStateReady(
      Option.getOrNull(
        AsyncResult.value(get(speechEnvironment.state({ environmentId, input: {} }))),
      ),
    ),
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((environmentId, index) => environmentId === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("speech:ready-environment-ids"));

export function useReadySpeechEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(readySpeechEnvironmentIdsAtom);
}

const selectVoiceEnvironmentId = (settings: ClientSettings) => settings.dictationEnvironmentId;

/**
 * The environment this device speaks through, or null when none can speak. Speech shares the
 * dictation machine: a pinned environment wins while it can speak, otherwise the thread's own
 * environment, then the primary, then any connected environment that can speak.
 */
export function useSpeechEnvironmentId(
  draftEnvironmentId: EnvironmentId | null = null,
): EnvironmentId | null {
  return resolveSpeechEnvironment({
    chosen: useClientSettings(selectVoiceEnvironmentId),
    draftEnvironmentId,
    primaryEnvironmentId: usePrimaryEnvironmentId(),
    ready: useReadySpeechEnvironmentIds(),
  });
}
