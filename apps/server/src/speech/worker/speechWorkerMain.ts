/**
 * Out-of-process home for the native sherpa-onnx addon. A crash or OOM here
 * (see the `oom_score_adj` write below) must never take the T3 server with it.
 */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A plain Node child: the addon load, the /proc write, and the idle-exit timer all run outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

interface NativeAddon {
  createOfflineRecognizerAsync(config: unknown): Promise<unknown>;
  offlineRecognizerSetConfig(handle: unknown, config: unknown): void;
  createOfflineStream(handle: unknown): unknown;
  acceptWaveformOffline(
    stream: unknown,
    waveform: { samples: Float32Array; sampleRate: number },
  ): void;
  decodeOfflineStreamAsync(handle: unknown, stream: unknown): Promise<unknown>;
  getOfflineStreamResultAsJson(stream: unknown): string;
}

type SpeechWorkerRequest =
  | { readonly id: number; readonly op: "recognizer.create"; runtimeDir: string; config: unknown }
  | { readonly id: number; readonly op: "recognizer.setConfig"; handleId: number; config: unknown }
  | {
      readonly id: number;
      readonly op: "recognizer.decode";
      handleId: number;
      samples: Float32Array;
      sampleRate: number;
    }
  | { readonly id: number; readonly op: "recognizer.release"; handleId: number };

/** Free native model memory shortly after the last recognizer goes away. */
const IDLE_EXIT_MS = 60_000;

export async function runSpeechWorker(): Promise<void> {
  // Best effort: let the kernel reclaim the worker before the agents (800) or the server.
  try {
    NodeFS.writeFileSync("/proc/self/oom_score_adj", "900");
  } catch {
    // Non-Linux hosts and locked-down containers have no such knob.
  }
  const addons = new Map<string, NativeAddon>();
  const handles = new Map<number, { readonly addon: NativeAddon; readonly handle: unknown }>();
  let nextHandleId = 1;
  let idleTimer: NodeJS.Timeout | null = null;

  const cancelIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const scheduleIdleExit = () => {
    cancelIdleExit();
    idleTimer = setTimeout(() => {
      if (handles.size === 0) process.exit(0);
    }, IDLE_EXIT_MS);
    // The IPC channel already keeps the process alive; the timer must not.
    idleTimer.unref();
  };
  const send = (message: unknown) => {
    process.send?.(message);
  };
  const succeed = (id: number, value: unknown) => {
    send({ id, ok: true, value });
  };
  const fail = (id: number, error: unknown) => {
    send({
      id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      },
    });
  };
  const addonFor = (runtimeDir: string): NativeAddon => {
    const existing = addons.get(runtimeDir);
    if (existing) return existing;
    const addon = NodeModule.createRequire(import.meta.url)(
      NodePath.join(runtimeDir, "sherpa-onnx.node"),
    ) as NativeAddon;
    addons.set(runtimeDir, addon);
    return addon;
  };
  const recognizerFor = (handleId: number) => {
    const entry = handles.get(handleId);
    if (!entry) throw new Error("The dictation recognizer is no longer loaded.");
    return entry;
  };

  const handle = async (request: SpeechWorkerRequest): Promise<void> => {
    switch (request.op) {
      case "recognizer.create": {
        // Before the slow load: the idle timer must not exit the process mid-create.
        cancelIdleExit();
        const addon = addonFor(request.runtimeDir);
        const handle = await addon.createOfflineRecognizerAsync(request.config).catch((error) => {
          if (handles.size === 0) scheduleIdleExit();
          throw error;
        });
        const handleId = nextHandleId++;
        handles.set(handleId, { addon, handle });
        succeed(request.id, handleId);
        return;
      }
      case "recognizer.setConfig": {
        const entry = recognizerFor(request.handleId);
        entry.addon.offlineRecognizerSetConfig(entry.handle, request.config);
        succeed(request.id, undefined);
        return;
      }
      case "recognizer.decode": {
        const entry = recognizerFor(request.handleId);
        const stream = entry.addon.createOfflineStream(entry.handle);
        entry.addon.acceptWaveformOffline(stream, {
          samples: request.samples,
          sampleRate: request.sampleRate,
        });
        await entry.addon.decodeOfflineStreamAsync(entry.handle, stream);
        succeed(request.id, entry.addon.getOfflineStreamResultAsJson(stream));
        return;
      }
      case "recognizer.release": {
        handles.delete(request.handleId);
        if (handles.size === 0) scheduleIdleExit();
        succeed(request.id, undefined);
        return;
      }
      default: {
        // Only reachable across a client/server version mismatch; never leave a request hanging.
        fail((request as SpeechWorkerRequest).id, new Error("Unknown speech worker operation."));
      }
    }
  };

  process.on("message", (raw) => {
    const request = raw as unknown as SpeechWorkerRequest;
    void handle(request).catch((error: unknown) => {
      fail(request.id, error);
    });
  });
  // The server owns the lifetime: no parent means nothing can ask us for a model again.
  process.on("disconnect", () => {
    process.exit(0);
  });
}
