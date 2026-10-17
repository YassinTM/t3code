/**
 * Out-of-process home for the native sherpa-onnx addon. A crash or OOM here
 * (see the `oom_score_adj` write below) must never take the T3 server with it.
 */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A plain Node child: the addon load, the /proc write, and the idle-exit timer all run outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

interface OfflineTtsResult {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

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
  createOfflineTtsAsync(config: unknown): Promise<unknown>;
  offlineTtsGenerateAsync(handle: unknown, config: unknown): Promise<OfflineTtsResult>;
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
  | { readonly id: number; readonly op: "recognizer.release"; handleId: number }
  | { readonly id: number; readonly op: "tts.create"; runtimeDir: string; config: unknown }
  | {
      readonly id: number;
      readonly op: "tts.generate";
      handleId: number;
      text: string;
      sid: number;
      speed: number;
    }
  | { readonly id: number; readonly op: "tts.release"; handleId: number };

type HandleKind = "recognizer" | "tts";

interface Handle {
  readonly kind: HandleKind;
  readonly addon: NativeAddon;
  readonly handle: unknown;
}

/** Free native model memory shortly after the last recognizer or TTS handle goes away. */
const IDLE_EXIT_MS = 60_000;

export async function runSpeechWorker(): Promise<void> {
  // Best effort: let the kernel reclaim the worker before the agents (800) or the server.
  try {
    NodeFS.writeFileSync("/proc/self/oom_score_adj", "900");
  } catch {
    // Non-Linux hosts and locked-down containers have no such knob.
  }
  const addons = new Map<string, NativeAddon>();
  const handles = new Map<number, Handle>();
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
  const handleFor = (handleId: number, kind: HandleKind) => {
    const entry = handles.get(handleId);
    if (!entry || entry.kind !== kind)
      throw new Error(
        kind === "tts"
          ? "The speech model is no longer loaded."
          : "The dictation recognizer is no longer loaded.",
      );
    return entry;
  };

  const createHandle = async (
    runtimeDir: string,
    kind: HandleKind,
    create: (addon: NativeAddon) => Promise<unknown>,
  ) => {
    // Before the slow load: the idle timer must not exit the process mid-create.
    cancelIdleExit();
    const addon = addonFor(runtimeDir);
    const handle = await create(addon).catch((error) => {
      if (handles.size === 0) scheduleIdleExit();
      throw error;
    });
    const handleId = nextHandleId++;
    handles.set(handleId, { kind, addon, handle });
    return handleId;
  };

  const handle = async (request: SpeechWorkerRequest): Promise<void> => {
    switch (request.op) {
      case "recognizer.create": {
        succeed(
          request.id,
          await createHandle(request.runtimeDir, "recognizer", (addon) =>
            addon.createOfflineRecognizerAsync(request.config),
          ),
        );
        return;
      }
      case "recognizer.setConfig": {
        const entry = handleFor(request.handleId, "recognizer");
        entry.addon.offlineRecognizerSetConfig(entry.handle, request.config);
        succeed(request.id, undefined);
        return;
      }
      case "recognizer.decode": {
        const entry = handleFor(request.handleId, "recognizer");
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
      case "tts.create": {
        succeed(
          request.id,
          await createHandle(request.runtimeDir, "tts", (addon) =>
            addon.createOfflineTtsAsync(request.config),
          ),
        );
        return;
      }
      case "tts.generate": {
        const entry = handleFor(request.handleId, "tts");
        const result = await entry.addon.offlineTtsGenerateAsync(entry.handle, {
          text: request.text,
          sid: request.sid,
          speed: request.speed,
          // The addon copies into a Float32Array we can send over IPC as-is.
          enableExternalBuffer: false,
        });
        succeed(request.id, { samples: result.samples, sampleRate: result.sampleRate });
        return;
      }
      case "tts.release": {
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
