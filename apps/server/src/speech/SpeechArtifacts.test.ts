// @effect-diagnostics nodeBuiltinImport:off -- The suite builds a real bzip2 archive with the system `tar` and hashes it with Node crypto.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type SpeechInstallState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as DictationArtifacts from "../dictation/DictationArtifacts.ts";
import * as SpeechArtifacts from "./SpeechArtifacts.ts";

/** The entries `kokoroEnV019.requiredEntries` expects, plus their exact byte content. */
const defaultEntries: Record<string, string> = {
  "model.onnx": "onnx bytes",
  "voices.bin": "voices bytes",
  "tokens.txt": "token bytes",
  "espeak-ng-data/phontab": "phoneme data",
};

interface Fixture {
  readonly root: string;
  /** The `.tar.bz2` bytes, ready to serve from a stubbed `HttpClient`. */
  readonly archive: Uint8Array;
  readonly bytes: number;
  readonly sha256: string;
  /** Where `SpeechArtifacts` extracts the model: `<root>/tts/kokoro-en-v0_19`. */
  readonly directory: string;
  /** Sum of the extracted file sizes `inspect` reports. */
  readonly size: number;
}

const makeFixture = (entries: Record<string, string> = defaultEntries): Fixture => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-speech-artifacts-"));
  const staging = NodePath.join(root, "staging");
  const modelDirectory = NodePath.join(staging, "kokoro-en-v0_19");
  for (const [name, contents] of Object.entries(entries)) {
    const target = NodePath.join(modelDirectory, name);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  }
  const archivePath = NodePath.join(root, "model.tar.bz2");
  NodeChildProcess.execFileSync("tar", ["-cjf", archivePath, "-C", staging, "kokoro-en-v0_19"]);
  const archive = NodeFS.readFileSync(archivePath);
  return {
    root,
    archive: new Uint8Array(archive),
    bytes: archive.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
    directory: NodePath.join(root, "tts", "kokoro-en-v0_19"),
    size: Object.values(entries).reduce(
      (total, contents) => total + Buffer.byteLength(contents),
      0,
    ),
  };
};

const cleanup = (fixture: Fixture) =>
  Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true }));

const httpFor = (archive: Uint8Array) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(archive, { headers: { "content-length": String(archive.byteLength) } }),
      ),
    ),
  );

const testLayer = (
  fixture: Fixture,
  http: HttpClient.HttpClient,
  options: {
    readonly model?: Partial<SpeechArtifacts.SpeechArtifactsOptions["model"]>;
    /** Null models a platform with no shared sherpa-onnx runtime build. */
    readonly runtimeDirectory?: string | null;
  } = {},
) =>
  SpeechArtifacts.layerWith({
    model: { bytes: fixture.bytes, sha256: fixture.sha256, ...options.model },
  }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(
      Layer.succeed(DictationArtifacts.DictationArtifacts, {
        supported: options.runtimeDirectory !== null,
        root: fixture.root,
        runtimeDirectory:
          options.runtimeDirectory === undefined
            ? NodePath.join(fixture.root, "runtime")
            : options.runtimeDirectory,
        paths: () => ({
          runtime: NodePath.join(fixture.root, "runtime"),
          model: NodePath.join(fixture.root, "models"),
        }),
        inspect: Effect.succeed({
          runtime: { _tag: "installed", sizeBytes: 0 },
          models: new Map(),
        }),
        ensureRuntime: () => Effect.void,
        install: () => Effect.void,
        remove: () => Effect.void,
      } satisfies DictationArtifacts.DictationArtifacts["Service"]),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("verifies and extracts the model, then reports its size", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const service = yield* SpeechArtifacts.SpeechArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const states: Array<SpeechInstallState> = [];
    yield* service.install((state) =>
      Effect.sync(() => {
        states.push(state);
      }),
    );

    assert.ok(states.some((state) => state._tag === "installing"));
    assert.ok(
      states.some((state) => state._tag === "installing" && state.totalBytes === fixture.bytes),
    );
    assert.deepStrictEqual(states.at(-1), { _tag: "installed", sizeBytes: fixture.size });
    assert.strictEqual(service.directory, fixture.directory);
    assert.deepStrictEqual(yield* service.inspect, { _tag: "installed", sizeBytes: fixture.size });
    assert.strictEqual(yield* fs.exists(NodePath.join(fixture.directory, "model.onnx")), true);
    assert.strictEqual(yield* fs.exists(NodePath.join(fixture.directory, "espeak-ng-data")), true);
    assert.strictEqual(yield* fs.exists(`${fixture.directory}.tmp`), false);
  }).pipe(
    Effect.provide(testLayer(fixture, httpFor(fixture.archive))),
    Effect.scoped,
    Effect.ensuring(cleanup(fixture)),
  );
});

it.effect("rejects a corrupt archive and cleans its staging", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const service = yield* SpeechArtifacts.SpeechArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const error = yield* service.install(() => Effect.void).pipe(Effect.flip);
    assert.strictEqual(error.reason, "install-failed");
    assert.strictEqual(error.message, "The speech download failed integrity verification.");
    assert.strictEqual(yield* fs.exists(`${fixture.directory}.tmp`), false);
    assert.strictEqual((yield* service.inspect)._tag, "not-installed");
  }).pipe(
    Effect.provide(
      testLayer(fixture, httpFor(fixture.archive), { model: { sha256: "0".repeat(64) } }),
    ),
    Effect.scoped,
    Effect.ensuring(cleanup(fixture)),
  );
});

it.effect("rejects an archive that is missing a required entry", () => {
  const { "model.onnx": _missing, ...entries } = defaultEntries;
  const fixture = makeFixture(entries);
  return Effect.gen(function* () {
    const service = yield* SpeechArtifacts.SpeechArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const error = yield* service.install(() => Effect.void).pipe(Effect.flip);
    assert.strictEqual(error.reason, "install-failed");
    assert.match(error.message, /missing model\.onnx/);
    assert.strictEqual(yield* fs.exists(fixture.directory), false);
    assert.strictEqual(yield* fs.exists(`${fixture.directory}.tmp`), false);
  }).pipe(
    Effect.provide(testLayer(fixture, httpFor(fixture.archive))),
    Effect.scoped,
    Effect.ensuring(cleanup(fixture)),
  );
});

it.effect("removes the installed model and abandoned staging", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const service = yield* SpeechArtifacts.SpeechArtifacts;
    const fs = yield* FileSystem.FileSystem;
    yield* service.install(() => Effect.void);
    yield* fs.makeDirectory(`${fixture.directory}.tmp`, { recursive: true });
    yield* fs.writeFileString(`${fixture.directory}.tmp/partial`, "partial download");

    yield* service.remove;
    assert.strictEqual(yield* fs.exists(fixture.directory), false);
    assert.strictEqual(yield* fs.exists(`${fixture.directory}.tmp`), false);
  }).pipe(
    Effect.provide(testLayer(fixture, httpFor(fixture.archive))),
    Effect.scoped,
    Effect.ensuring(cleanup(fixture)),
  );
});

it.effect("refuses to install when the platform has no runtime", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const service = yield* SpeechArtifacts.SpeechArtifacts;
    assert.strictEqual(service.supported, false);
    assert.strictEqual(service.runtimeDirectory, null);
    const error = yield* service.install(() => Effect.void).pipe(Effect.flip);
    assert.strictEqual(error.reason, "unsupported-platform");
  }).pipe(
    Effect.provide(testLayer(fixture, httpFor(fixture.archive), { runtimeDirectory: null })),
    Effect.scoped,
    Effect.ensuring(cleanup(fixture)),
  );
});
