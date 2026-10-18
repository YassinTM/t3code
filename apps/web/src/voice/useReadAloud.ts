/**
 * React wiring for read-aloud: connects one message row to the app-wide manager and to the speech
 * machine this device speaks through, and reports failures next to the button.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SpeechSynthesizeResult } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore, type RefObject } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import { readAloudManager, type ReadAloudStatus } from "./readAloud";
import { showReadAloudErrorToast } from "./readAloudToast";
import { speechPlayer } from "./speechPlayerInstance";
import { speechEnvironment } from "./speechState";

const IDLE: ReadAloudStatus = "idle";

export interface ReadAloud {
  readonly status: ReadAloudStatus;
  readonly toggle: () => void;
}

/**
 * Drives the shared read-aloud manager for one message. While the row streams, its growing
 * Markdown is handed to the active session; that session is finished once streaming stops.
 */
export function useReadAloud(input: {
  readonly messageId: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
}): ReadAloud {
  const { messageId, text, streaming, environmentId, buttonRef } = input;
  const synthesize = useAtomCommand(speechEnvironment.synthesize, { reportFailure: false });

  const status = useSyncExternalStore(
    (listener) => readAloudManager.subscribe(listener),
    () => readAloudManager.status(messageId),
    () => IDLE,
  );

  // Only the row that owns the one live session may feed it more text.
  useEffect(() => {
    if (status === "idle") return;
    readAloudManager.push(messageId, text);
  }, [messageId, status, text]);

  useEffect(() => {
    if (status === "idle" || streaming) return;
    readAloudManager.finish(messageId);
  }, [messageId, status, streaming]);

  async function synthesizeChunk(chunk: string): Promise<SpeechSynthesizeResult> {
    if (environmentId === null) throw new Error("No machine can read aloud yet.");
    const result = await synthesize({ environmentId, input: { text: chunk } });
    if (result._tag === "Success") return result.value;
    if (isAtomCommandInterrupted(result)) throw new Error("Read aloud stopped.");
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error ? failure : new Error(String(failure));
  }

  function toggle(): void {
    if (readAloudManager.status(messageId) !== "idle") {
      readAloudManager.stopKey(messageId);
      return;
    }
    if (environmentId === null) {
      showReadAloudErrorToast(buttonRef, new Error("No machine can read aloud yet."));
      return;
    }
    // The audio context may only start inside the click that asked for it.
    speechPlayer.prime();
    readAloudManager.start(messageId, text, streaming, {
      synthesize: synthesizeChunk,
      player: speechPlayer,
      onError: (error) => showReadAloudErrorToast(buttonRef, error),
    });
  }

  return { status, toggle };
}
