import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import {
  DictationError,
  type DictationInstallState,
  type DictationModelId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import { models, runtimeFor } from "./models.ts";
import { downloadArtifact } from "./artifactDownload.ts";
import { readTar } from "./tar.ts";

export class DictationArtifacts extends Context.Service<
  DictationArtifacts,
  {
    readonly supported: boolean;
    /** `<stateDir>/dictation`: the base every local speech artifact lives under. */
    readonly root: string;
    /** The shared sherpa-onnx native runtime, or null when this platform has no build. */
    readonly runtimeDirectory: string | null;
    readonly paths: (model: DictationModelId) => { runtime: string; model: string };
    readonly inspect: Effect.Effect<
      {
        runtime: DictationInstallState;
        models: ReadonlyMap<DictationModelId, DictationInstallState>;
      },
      DictationError
    >;
    /** Installs the native runtime when it is missing; a no-op once it is complete. */
    readonly ensureRuntime: (
      progress: (state: DictationInstallState) => Effect.Effect<void>,
    ) => Effect.Effect<void, DictationError>;
    readonly install: (
      model: DictationModelId,
      progress: (
        artifact: "runtime" | DictationModelId,
        state: DictationInstallState,
      ) => Effect.Effect<void>,
    ) => Effect.Effect<void, DictationError>;
    readonly remove: (model: DictationModelId) => Effect.Effect<void, DictationError>;
  }
>()("t3/dictation/DictationArtifacts") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const mutations = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "dictation");
  const runtime = runtimeFor(yield* HostProcess.Platform, yield* HostProcess.Architecture);
  const runtimeDirectory = runtime === null ? null : path.join(root, "runtime", runtime.directory);
  const paths = (model: DictationModelId) => ({
    runtime: runtimeDirectory ?? path.join(root, "runtime", "unsupported"),
    model: path.join(root, "models", model),
  });
  const io = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.mapError(
        (cause) =>
          new DictationError({
            reason: "install-failed",
            message: "Could not access dictation files.",
            cause,
          }),
      ),
    );
  const failed = (message: string, cause?: unknown) =>
    new DictationError({
      reason: "install-failed",
      message,
      ...(cause === undefined ? {} : { cause }),
    });
  const download = (
    url: string,
    destination: string,
    algorithm: "sha256" | "sha512",
    expected: string,
    maxBytes: number,
    progress: (received: number, total: number) => Effect.Effect<void>,
  ) =>
    downloadArtifact({
      http,
      fs,
      failed,
      noun: "dictation",
      url,
      destination,
      algorithm,
      expected,
      maxBytes,
      progress,
    });
  const size = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      io,
    );
  const inspect = Effect.gen(function* () {
    let runtimeComplete = runtime !== null;
    let runtimeSize = 0;
    for (const name of runtime?.nativeFiles ?? []) {
      const actual = yield* size(path.join(paths("parakeet-v3").runtime, name));
      runtimeComplete &&= actual !== null && actual > 0;
      runtimeSize += actual ?? 0;
    }
    const installed = new Map<DictationModelId, DictationInstallState>();
    for (const id of Object.keys(models) as DictationModelId[]) {
      let complete = true;
      let bytes = 0;
      for (const file of models[id].files) {
        const actual = yield* size(path.join(paths(id).model, file.name));
        complete &&= actual === file.bytes;
        bytes += actual ?? 0;
      }
      installed.set(
        id,
        complete ? { _tag: "installed", sizeBytes: bytes } : { _tag: "not-installed" },
      );
    }
    return {
      runtime: !runtimeComplete
        ? { _tag: "not-installed" as const }
        : { _tag: "installed" as const, sizeBytes: runtimeSize },
      models: installed,
    };
  });

  // Downloads stream to temporary files. The AbortSignal and finalizer own partial-file cleanup.
  const atomicInstall = Effect.fnUntraced(function* (
    destination: string,
    write: (temporary: string) => Effect.Effect<void, DictationError, Scope.Scope>,
  ) {
    const temporary = `${destination}.tmp`;
    yield* io(fs.makeDirectory(path.dirname(destination), { recursive: true }));
    // A previous process may have exited before its staging finalizer ran.
    yield* io(fs.remove(temporary, { recursive: true, force: true }));
    yield* Effect.acquireRelease(io(fs.makeDirectory(temporary)), () =>
      fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    yield* write(temporary);
    yield* io(fs.remove(destination, { recursive: true, force: true }));
    yield* io(fs.rename(temporary, destination));
  });

  /**
   * Installs the shared native runtime when it is incomplete, so both dictation and
   * speech can rely on one copy. `progress` receives the same states `install` reports.
   */
  const installRuntime = Effect.fnUntraced(function* (
    progress: (state: DictationInstallState) => Effect.Effect<void>,
  ) {
    if (!runtime)
      return yield* new DictationError({
        reason: "unsupported-platform",
        message: "Local dictation is unavailable on this platform.",
      });
    const current = yield* inspect;
    if (current.runtime._tag === "installed") {
      yield* progress(current.runtime);
      return;
    }
    let lastProgress = -Infinity;
    const report = (state: DictationInstallState) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - lastProgress >= 250) {
          yield* progress(state);
          lastProgress = now;
        }
      });
    yield* progress({ _tag: "installing", receivedBytes: 0, totalBytes: 0 });
    yield* atomicInstall(path.join(root, "runtime", runtime.directory), (temporary) =>
      Effect.gen(function* () {
        const archive = path.join(temporary, "runtime.tgz");
        yield* download(
          runtime.url,
          archive,
          "sha512",
          runtime.integrity,
          128 * 1024 * 1024,
          (receivedBytes, totalBytes) => report({ _tag: "installing", receivedBytes, totalBytes }),
        );
        const compressed = yield* io(fs.readFile(archive));
        const expanded = yield* Effect.tryPromise({
          try: () =>
            NodeUtil.promisify(NodeZlib.gunzip)(compressed, {
              maxOutputLength: 512 * 1024 * 1024,
            }),
          catch: (cause) =>
            new DictationError({
              reason: "install-failed",
              message: "The dictation runtime archive was invalid.",
              cause,
            }),
        });
        const files = yield* Effect.try({
          try: () => readTar(expanded),
          catch: (cause) =>
            new DictationError({
              reason: "install-failed",
              message: "The dictation runtime archive was invalid.",
              cause,
            }),
        });
        if (
          !runtime.nativeFiles.every((name) =>
            files.some((file) => file.path === name && file.bytes.length > 0),
          )
        )
          return yield* new DictationError({
            reason: "install-failed",
            message: "The dictation runtime addon was missing.",
          });
        for (const file of files) {
          const target = path.join(temporary, file.path);
          yield* io(fs.makeDirectory(path.dirname(target), { recursive: true }));
          yield* io(fs.writeFile(target, file.bytes));
        }
        yield* io(fs.remove(archive));
      }),
    );
    yield* progress((yield* inspect).runtime);
  }, Effect.scoped);

  const ensureRuntime: DictationArtifacts["Service"]["ensureRuntime"] = (progress) =>
    mutations.withPermit(installRuntime(progress));

  const install: DictationArtifacts["Service"]["install"] = Effect.fnUntraced(
    function* (model, progress) {
      yield* installRuntime((state) => progress("runtime", state));
      const current = yield* inspect;
      const existingModel = current.models.get(model);
      if (existingModel?._tag === "installed") {
        yield* progress(model, existingModel);
        return;
      }
      let lastProgress = -Infinity;
      const report: typeof progress = (artifact, state) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now - lastProgress >= 250) {
            yield* progress(artifact, state);
            lastProgress = now;
          }
        });
      const totalBytes = models[model].files.reduce((total, file) => total + file.bytes, 0);
      yield* progress(model, { _tag: "installing", receivedBytes: 0, totalBytes });
      yield* atomicInstall(paths(model).model, (temporary) =>
        Effect.gen(function* () {
          let completed = 0;
          for (const file of models[model].files) {
            completed += yield* download(
              file.url,
              path.join(temporary, file.name),
              "sha256",
              file.sha256,
              file.bytes,
              (received) =>
                report(model, {
                  _tag: "installing",
                  receivedBytes: completed + received,
                  totalBytes,
                }),
            );
          }
        }),
      );
      yield* progress(model, { _tag: "installed", sizeBytes: totalBytes });
    },
    Effect.scoped,
    mutations.withPermit,
  );
  const remove = Effect.fnUntraced(function* (model: DictationModelId) {
    const destination = paths(model).model;
    yield* io(fs.remove(destination, { recursive: true, force: true }));
    yield* io(fs.remove(`${destination}.tmp`, { recursive: true, force: true }));
  });
  return DictationArtifacts.of({
    supported: runtime !== null,
    root,
    runtimeDirectory,
    paths,
    inspect,
    ensureRuntime,
    install,
    remove,
  });
});

export const layer = Layer.effect(DictationArtifacts, make);
