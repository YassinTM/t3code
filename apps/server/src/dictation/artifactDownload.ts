import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";

import { createIntegrityHash } from "./integrity.ts";

export interface ArtifactDownloadOptions<Failure> {
  readonly http: HttpClient.HttpClient;
  readonly fs: FileSystem.FileSystem;
  /**
   * Builds the caller's install-failed error. Dictation and speech keep their own error
   * types and wording, so only the noun differs ("Could not download dictation files.").
   */
  readonly failed: (message: string, cause?: unknown) => Failure;
  /** Feature noun used in every failure message. */
  readonly noun: string;
  readonly url: string;
  readonly destination: string;
  readonly algorithm: "sha256" | "sha512";
  readonly expected: string;
  readonly maxBytes: number;
  readonly progress: (received: number, total: number) => Effect.Effect<void>;
}

/**
 * Streams one artifact to `destination`, hashing as it goes and rejecting a response that
 * is over budget or fails verification. The caller owns the temporary directory; the
 * partial file stays there until its staging finalizer removes it.
 */
export const downloadArtifact = <Failure>(
  options: ArtifactDownloadOptions<Failure>,
): Effect.Effect<number, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const { http, fs, failed, noun } = options;
    const response = yield* http.get(options.url).pipe(
      Effect.mapError((cause) => failed(`Could not download ${noun} files.`, cause)),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(failed(`The ${noun} download timed out.`)),
      }),
    );
    if (response.status !== 200)
      return yield* Effect.fail(failed(`The ${noun} download was unavailable.`));
    const total = Number(response.headers["content-length"]) || options.maxBytes;
    const file = yield* fs
      .open(options.destination, { flag: "wx" })
      .pipe(Effect.mapError((cause) => failed(`Could not access ${noun} files.`, cause)));
    const hash = createIntegrityHash(options.algorithm);
    let received = 0;
    yield* response.stream.pipe(
      Stream.timeout("30 seconds"),
      Stream.mapError((cause) => failed(`The ${noun} download was interrupted.`, cause)),
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          received += bytes.length;
          if (received > options.maxBytes)
            return yield* Effect.fail(failed(`The ${noun} download exceeded its expected size.`));
          hash.update(bytes);
          yield* file
            .writeAll(bytes)
            .pipe(Effect.mapError((cause) => failed(`Could not access ${noun} files.`, cause)));
          yield* options.progress(received, total);
        }),
      ),
    );
    if (hash.digest(options.algorithm === "sha512" ? "base64" : "hex") !== options.expected)
      return yield* Effect.fail(failed(`The ${noun} download failed integrity verification.`));
    return received;
  }).pipe(Effect.scoped);
