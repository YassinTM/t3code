/** Parent-side owner of the out-of-process dictation runtime; see ./worker/speechWorkerMain.ts. */
// @effect-diagnostics nodeBuiltinImport:off -- Child-process IPC events fire at native callback boundaries, outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** The worker process is gone: crashed, timed out, or tripped the crash limit. */
export class SpeechWorkerGone extends Schema.TaggedError<SpeechWorkerGone>()("SpeechWorkerGone", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** The worker answered, but the native call failed. */
export class SpeechWorkerError extends Schema.TaggedError<SpeechWorkerError>()(
  "SpeechWorkerError",
  {
    message: Schema.String,
  },
) {}

export type SpeechWorkerFailure = SpeechWorkerGone | SpeechWorkerError;

export class SpeechWorker extends Context.Service<
  SpeechWorker,
  {
    readonly create: (
      runtimeDir: string,
      config: unknown,
    ) => Effect.Effect<number, SpeechWorkerFailure>;
    readonly setConfig: (
      handleId: number,
      config: unknown,
    ) => Effect.Effect<void, SpeechWorkerFailure>;
    readonly decode: (
      handleId: number,
      samples: Float32Array,
      sampleRate: number,
    ) => Effect.Effect<string, SpeechWorkerFailure>;
    readonly release: (handleId: number) => Effect.Effect<void, SpeechWorkerFailure>;
    readonly ttsCreate: (
      runtimeDir: string,
      config: unknown,
    ) => Effect.Effect<number, SpeechWorkerFailure>;
    readonly ttsGenerate: (input: {
      readonly handleId: number;
      readonly text: string;
      readonly sid: number;
      readonly speed: number;
    }) => Effect.Effect<{ samples: Float32Array; sampleRate: number }, SpeechWorkerFailure>;
    readonly ttsRelease: (handleId: number) => Effect.Effect<void, SpeechWorkerFailure>;
  }
>()("t3/speech/SpeechWorker") {}

interface Timeouts {
  readonly create: number;
  readonly decode: number;
  readonly ttsGenerate: number;
  readonly other: number;
}

const defaultTimeouts: Timeouts = {
  create: 120_000,
  decode: 30_000,
  ttsGenerate: 60_000,
  other: 10_000,
};
const crashWindowMs = 5 * 60_000;
const crashLimit = 3;

export interface SpeechWorkerOptions {
  /** Test seam: run this command instead of this binary's hidden `__speech-worker` entry. */
  readonly spawn?: { readonly command: string; readonly args: ReadonlyArray<string> };
  readonly timeouts?: Partial<Timeouts>;
}

interface SpeechWorkerReply {
  readonly id: number;
  readonly ok: boolean;
  readonly value: unknown;
  readonly error: { readonly message?: string } | undefined;
}

const decodeReply = (raw: unknown): SpeechWorkerReply | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id, ok, value, error } = raw as {
    id?: unknown;
    ok?: unknown;
    value?: unknown;
    error?: unknown;
  };
  if (typeof id !== "number" || typeof ok !== "boolean") return undefined;
  return {
    id,
    ok,
    value,
    error:
      typeof error === "object" && error !== null ? (error as { message?: string }) : undefined,
  };
};

const make = (options: SpeechWorkerOptions) =>
  Effect.gen(function* () {
    const executable = yield* HostProcess.ExecutablePath;
    const argv = yield* HostProcess.Arguments;
    const isExecutable = yield* HostProcess.IsExecutable;
    const environment = yield* HostProcess.Environment;
    const clock = yield* Clock.Clock;
    const timeouts = { ...defaultTimeouts, ...options.timeouts };
    // A packaged executable carries the worker behind a hidden subcommand; a JS build re-runs
    // this file. `ELECTRON_RUN_AS_NODE` and friends stay inherited.
    const command = options.spawn?.command ?? executable;
    const args =
      options.spawn?.args ??
      (isExecutable ? ["__speech-worker"] : [argv[1] ?? "", "__speech-worker"]);

    let child: NodeChildProcess.ChildProcess | null = null;
    let lastGone: SpeechWorkerGone | null = null;
    let nextRequestId = 1;
    let crashes: number[] = [];
    let shuttingDown = false;
    const inFlight = new Map<
      number,
      {
        readonly succeed: (value: unknown) => void;
        readonly fail: (error: SpeechWorkerFailure) => void;
      }
    >();

    const finishRequest = (
      id: number,
      outcome:
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly error: SpeechWorkerFailure },
    ) => {
      const pending = inFlight.get(id);
      if (!pending) return;
      inFlight.delete(id);
      if (outcome.ok) pending.succeed(outcome.value);
      else pending.fail(outcome.error);
    };
    const failInFlight = (error: SpeechWorkerFailure) => {
      // Snapshot first: resuming a request runs its fiber synchronously, and that fiber may
      // already start the next request against the replacement worker.
      const pending = [...inFlight.values()];
      inFlight.clear();
      for (const entry of pending) entry.fail(error);
    };
    const markGone = (
      spawned: NodeChildProcess.ChildProcess,
      message: string,
      cause: unknown,
      crashed: boolean,
    ) => {
      if (child !== spawned) return;
      child = null;
      if (crashed && !shuttingDown) crashes.push(clock.currentTimeMillisUnsafe());
      const error = new SpeechWorkerGone({
        message,
        ...(cause === undefined ? {} : { cause }),
      });
      lastGone = error;
      failInFlight(error);
    };
    const spawnWorker = () => {
      const spawned = NodeChildProcess.spawn(command, [...args], {
        env: environment,
        // Native addon noise belongs in the server's logs, next to the session that asked for it.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        // Audio is a Float32Array; the default JSON channel would turn it into an object.
        serialization: "advanced",
      });
      child = spawned;
      lastGone = null;
      spawned.on("message", (raw: unknown) => {
        const reply = decodeReply(raw);
        if (!reply) return;
        finishRequest(
          reply.id,
          reply.ok
            ? { ok: true, value: reply.value }
            : {
                ok: false,
                error: new SpeechWorkerError({
                  message: reply.error?.message ?? "The dictation runtime failed.",
                }),
              },
        );
      });
      const markThisGone = (message: string, cause: unknown, crashed: boolean) =>
        markGone(spawned, message, cause, crashed);
      spawned.once("error", (cause) =>
        markThisGone("The speech worker exited unexpectedly.", cause, true),
      );
      spawned.once("exit", (code, signal) =>
        markThisGone(
          "The speech worker exited unexpectedly.",
          code === 0 && signal === null
            ? undefined
            : `the worker exited with code ${String(code)}${signal === null ? "" : ` (${signal})`}`,
          // The worker idles down 60 s after the last recognizer goes away; that is not a crash.
          !(code === 0 && signal === null),
        ),
      );
      return spawned;
    };

    const request = <A>(
      op: string,
      args: Record<string, unknown>,
      timeoutMs: number,
    ): Effect.Effect<A, SpeechWorkerFailure> =>
      Effect.gen(function* () {
        if (shuttingDown)
          return yield* new SpeechWorkerGone({ message: "The speech worker is shutting down." });
        const now = yield* Clock.currentTimeMillis;
        crashes = crashes.filter((at) => now - at < crashWindowMs);
        if (crashes.length >= crashLimit)
          return yield* new SpeechWorkerGone({
            message: "The speech worker keeps crashing, so dictation is paused for a few minutes.",
          });
        const spawned = child ?? spawnWorker();
        const id = nextRequestId++;
        return yield* Effect.callback<A, SpeechWorkerFailure>((resume) => {
          const discard = Effect.sync(() => {
            inFlight.delete(id);
          });
          inFlight.set(id, {
            succeed: (value) => resume(Effect.succeed(value as A)),
            fail: (error) => resume(Effect.fail(error)),
          });
          // Spawning cannot fail synchronously, but a bad command can exit before we send.
          if (child !== spawned) {
            finishRequest(id, {
              ok: false,
              error: lastGone ?? new SpeechWorkerGone({ message: "The speech worker is gone." }),
            });
            return discard;
          }
          try {
            spawned.send({ id, op, ...args }, (error) => {
              if (error)
                finishRequest(id, {
                  ok: false,
                  error: new SpeechWorkerGone({
                    message: "Could not reach the speech worker.",
                    cause: error,
                  }),
                });
            });
          } catch (cause) {
            finishRequest(id, {
              ok: false,
              error: new SpeechWorkerGone({ message: "Could not reach the speech worker.", cause }),
            });
          }
          return discard;
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.sync(() => {
                // The worker ignored its deadline. Take it out of service now: its exit event
                // arrives a tick later, and a request sent in that window would go nowhere.
                inFlight.delete(id);
                // A wedged worker is not a crash; the next request simply starts a fresh one.
                markGone(spawned, "The speech worker stopped responding.", undefined, false);
                if (spawned.exitCode === null && spawned.signalCode === null)
                  spawned.kill("SIGKILL");
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new SpeechWorkerGone({ message: "The speech worker did not respond in time." }),
                  ),
                ),
              ),
          }),
        );
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        shuttingDown = true;
        const spawned = child;
        if (!spawned) return;
        spawned.kill("SIGTERM");
        // Wait for a clean exit so a wedged worker cannot outlive the server; SIGKILL if it ignores us.
        yield* Effect.callback<void>((resume) => {
          spawned.once("exit", () => {
            resume(Effect.void);
          });
          return Effect.void;
        }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }));
        if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill("SIGKILL");
      }),
    );

    return SpeechWorker.of({
      create: (runtimeDir, config) =>
        request("recognizer.create", { runtimeDir, config }, timeouts.create),
      setConfig: (handleId, config) =>
        request("recognizer.setConfig", { handleId, config }, timeouts.other),
      decode: (handleId, samples, sampleRate) =>
        request("recognizer.decode", { handleId, samples, sampleRate }, timeouts.decode),
      release: (handleId) => request("recognizer.release", { handleId }, timeouts.other),
      ttsCreate: (runtimeDir, config) =>
        request("tts.create", { runtimeDir, config }, timeouts.create),
      ttsGenerate: (input) => request("tts.generate", { ...input }, timeouts.ttsGenerate),
      ttsRelease: (handleId) => request("tts.release", { handleId }, timeouts.other),
    });
  });

export const layerWith = (options: SpeechWorkerOptions = {}) =>
  Layer.effect(SpeechWorker, make(options));

export const layer = layerWith();
