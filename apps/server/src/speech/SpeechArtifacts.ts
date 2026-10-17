// @effect-diagnostics nodeBuiltinImport:off -- Node has no bzip2 decoder, so the verified archive is unpacked with the system `tar`.
import * as NodeChildProcess from "node:child_process";
import { type SpeechInstallState, SpeechError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import { downloadArtifact } from "../dictation/artifactDownload.ts";
import * as DictationArtifacts from "../dictation/DictationArtifacts.ts";
import { kokoroEnV019, type SpeechModelArtifact } from "./models.ts";

/**
 * Download and install of the pinned Kokoro model. It lives beside the dictation models
 * (`<dictation root>/tts/<archive root>`) and shares the pinned sherpa-onnx runtime that
 * `DictationArtifacts` installs, so a host that already dictates does not download it twice.
 */
export class SpeechArtifacts extends Context.Service<
  SpeechArtifacts,
  {
    readonly supported: boolean;
    /** Where the extracted model lives; also the native config's data directory. */
    readonly directory: string;
    /** The shared sherpa-onnx runtime directory, or null when unsupported. */
    readonly runtimeDirectory: string | null;
    readonly inspect: Effect.Effect<SpeechInstallState, SpeechError>;
    /** Installs the runtime when needed, then the model; `progress` mirrors both. */
    readonly install: (
      progress: (state: SpeechInstallState) => Effect.Effect<void>,
    ) => Effect.Effect<void, SpeechError>;
    readonly remove: Effect.Effect<void, SpeechError>;
  }
>()("t3/speech/SpeechArtifacts") {}

export interface SpeechArtifactsOptions {
  /** Test seam: pin the same archive's bytes and hash to a local fixture. */
  readonly model?: Partial<SpeechModelArtifact>;
}

const make = (options: SpeechArtifactsOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const dictation = yield* DictationArtifacts.DictationArtifacts;
    const mutations = yield* Semaphore.make(1);
    const model: SpeechModelArtifact = { ...kokoroEnV019, ...options.model };
    const directory = path.join(dictation.root, "tts", model.directory);
    const failed = (message: string, cause?: unknown) =>
      new SpeechError({
        reason: "install-failed",
        message,
        ...(cause === undefined ? {} : { cause }),
      });
    const io = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      operation.pipe(Effect.mapError((cause) => failed("Could not access speech files.", cause)));

    const directorySize = (target: string): Effect.Effect<number, SpeechError> =>
      Effect.gen(function* () {
        let total = 0;
        for (const entry of yield* io(fs.readDirectory(target))) {
          const info = yield* io(fs.stat(path.join(target, entry)));
          if (info.type === "File") total += Number(info.size);
          else if (info.type === "Directory")
            total += yield* directorySize(path.join(target, entry));
        }
        return total;
      });

    const inspect = Effect.gen(function* () {
      let complete = true;
      let bytes = 0;
      for (const entry of model.requiredEntries) {
        const target = path.join(directory, entry);
        const info = yield* fs.stat(target).pipe(
          Effect.catchIf(
            (cause) => cause.reason._tag === "NotFound",
            () => Effect.succeed(null),
          ),
          io,
        );
        if (info === null) {
          complete = false;
          continue;
        }
        if (info.type === "Directory") bytes += yield* directorySize(target);
        else if (info.type === "File" && Number(info.size) > 0) bytes += Number(info.size);
        else complete = false;
      }
      return complete
        ? ({ _tag: "installed", sizeBytes: bytes } satisfies SpeechInstallState)
        : ({ _tag: "not-installed" } satisfies SpeechInstallState);
    });

    const matchingSize = (target: string) =>
      fs.stat(target).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
        io,
      );

    const extract = (archive: string, into: string) =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            const child = NodeChildProcess.spawn("tar", ["-xjf", archive, "-C", into], {
              stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
              if (stderr.length < 2_000) stderr += chunk.toString("utf8");
            });
            child.once("error", reject);
            // The hash is pinned, so the bytes are trusted; a non-zero exit still means the
            // staging directory is incomplete and must not be promoted.
            child.once("exit", (code, signal) =>
              code === 0 && signal === null
                ? resolve()
                : reject(
                    new Error(
                      `tar exited with code ${String(code)}${signal === null ? "" : ` (${signal})`}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
                    ),
                  ),
            );
          }),
        catch: (cause) => failed("The speech model archive could not be extracted.", cause),
      });

    const installModel = Effect.fnUntraced(function* (
      progress: (state: SpeechInstallState) => Effect.Effect<void>,
    ) {
      const temporary = `${directory}.tmp`;
      yield* io(fs.makeDirectory(path.dirname(directory), { recursive: true }));
      // A previous process may have exited before its staging finalizer ran.
      yield* io(fs.remove(temporary, { recursive: true, force: true }));
      yield* Effect.acquireRelease(io(fs.makeDirectory(temporary)), () =>
        fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const archive = path.join(temporary, `${model.directory}.tar.bz2`);
      let lastProgress = -Infinity;
      yield* downloadArtifact({
        http,
        fs,
        failed,
        noun: "speech",
        url: model.url,
        destination: archive,
        algorithm: "sha256",
        expected: model.sha256,
        maxBytes: model.bytes,
        progress: (received, total) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgress < 250) return;
            lastProgress = now;
            yield* progress({ _tag: "installing", receivedBytes: received, totalBytes: total });
          }),
      });
      yield* extract(archive, temporary);
      yield* io(fs.remove(archive));
      const extracted = path.join(temporary, model.directory);
      for (const entry of model.requiredEntries) {
        const info = yield* matchingSize(path.join(extracted, entry));
        if (info === null || (info.type === "File" && Number(info.size) === 0))
          return yield* failed(`The speech model archive was missing ${entry}.`);
      }
      yield* io(fs.remove(directory, { recursive: true, force: true }));
      yield* io(fs.rename(extracted, directory));
      yield* io(fs.remove(temporary, { recursive: true, force: true }));
    }, Effect.scoped);

    const install: SpeechArtifacts["Service"]["install"] = Effect.fnUntraced(function* (progress) {
      if (dictation.runtimeDirectory === null)
        return yield* new SpeechError({
          reason: "unsupported-platform",
          message: "Local speech is unavailable on this platform.",
        });
      const current = yield* inspect;
      if (current._tag === "installed") {
        yield* progress(current);
        return;
      }
      yield* progress({ _tag: "installing", receivedBytes: 0, totalBytes: model.bytes });
      // The model is useless without the native runtime, and the runtime is much smaller.
      yield* dictation
        .ensureRuntime(() => Effect.void)
        .pipe(
          Effect.catchTags({
            DictationError: (cause) =>
              Effect.fail(
                new SpeechError({
                  reason: "install-failed",
                  message: "Could not install the speech runtime.",
                  cause,
                }),
              ),
          }),
        );
      yield* installModel(progress);
      const final = yield* inspect;
      if (final._tag === "installed") yield* progress(final);
    }, mutations.withPermit);

    const remove = mutations.withPermit(
      io(fs.remove(directory, { recursive: true, force: true })).pipe(
        Effect.andThen(io(fs.remove(`${directory}.tmp`, { recursive: true, force: true }))),
      ),
    );

    return SpeechArtifacts.of({
      supported: dictation.runtimeDirectory !== null,
      directory,
      runtimeDirectory: dictation.runtimeDirectory,
      inspect,
      install,
      remove,
    });
  });

export const layerWith = (options: SpeechArtifactsOptions = {}) =>
  Layer.effect(SpeechArtifacts, make(options));

export const layer = layerWith();
