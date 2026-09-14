import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  extractAvailableModels,
  makePiRpcTransport,
  piModelInfoToServerModel,
} from "./PiRpcClient.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

// Outer hard wall on the whole discovery effect. `transport.request` has its own
// per-request timeout (see PI_MODEL_DISCOVERY_REQUEST_TIMEOUT_MS below); keep the
// outer wall strictly larger so the inner request owns cleanup/logging and the
// outer only fires as a defensive backstop.
// Model discovery must load extensions because they can register providers.
// Slow extension initialization has exceeded the previous 14-second request
// deadline in production, even when Pi eventually returns a valid catalog.
const PI_MODEL_DISCOVERY_TIMEOUT_MS = 31_000;
const PI_MODEL_DISCOVERY_REQUEST_TIMEOUT_MS = 30_000;
// Pi can spend several seconds loading extensions before printing its version.
// Keep this provider-specific probe above the shared 4-second CLI default.
const PI_VERSION_PROBE_TIMEOUT_MS = 15_000;
const MIN_PI_VERSION = "0.83.0";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type PiModelDiscoveryResult =
  | { readonly _tag: "success"; readonly models: ReadonlyArray<ServerProviderModel> }
  | { readonly _tag: "empty" }
  | { readonly _tag: "no-response"; readonly reason: "timeout" | "transport-closed" }
  | { readonly _tag: "invalid-response" }
  | { readonly _tag: "process-failure" };

const runPiVersion = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const binaryPath = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: environment,
    });
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    });
    return yield* spawnAndCollect(binaryPath, command);
  });

/** Discover models via a short-lived `pi --mode rpc` session. */
export const discoverPiModelsViaRpc = Effect.fn("discoverPiModelsViaRpc")(
  function* (piSettings: PiSettings, cwd: string, environment: NodeJS.ProcessEnv) {
    const transport = yield* makePiRpcTransport({
      binaryPath: piSettings.binaryPath || "pi",
      args: ["--mode", "rpc", "--no-session"],
      cwd,
      env: environment,
      onExit: Effect.void,
    });
    const response = yield* transport.request(
      { type: "get_available_models" },
      "pi-model-discovery",
      PI_MODEL_DISCOVERY_REQUEST_TIMEOUT_MS,
    );
    if (response === undefined) {
      const isClosed = yield* transport.isClosed;
      return {
        _tag: "no-response",
        reason: isClosed ? "transport-closed" : "timeout",
      } satisfies PiModelDiscoveryResult;
    }

    const data = response.data;
    if (
      response.type !== "response" ||
      response.command !== "get_available_models" ||
      response.success !== true ||
      data === null ||
      typeof data !== "object" ||
      !Array.isArray((data as Record<string, unknown>)["models"])
    ) {
      return { _tag: "invalid-response" } satisfies PiModelDiscoveryResult;
    }

    const rawModels = (data as Record<string, unknown>)["models"] as ReadonlyArray<unknown>;
    const models = extractAvailableModels(response).map(piModelInfoToServerModel);
    if (models.length !== rawModels.length) {
      return { _tag: "invalid-response" } satisfies PiModelDiscoveryResult;
    }
    if (models.length === 0) {
      return { _tag: "empty" } satisfies PiModelDiscoveryResult;
    }
    return { _tag: "success", models } satisfies PiModelDiscoveryResult;
  },
  Effect.scoped,
  Effect.timeoutOption(PI_MODEL_DISCOVERY_TIMEOUT_MS),
  Effect.map(
    Option.getOrElse(
      () => ({ _tag: "no-response", reason: "timeout" }) satisfies PiModelDiscoveryResult,
    ),
  ),
  Effect.catchCause(() =>
    Effect.logWarning("Pi model discovery process failed").pipe(
      Effect.as({ _tag: "process-failure" } satisfies PiModelDiscoveryResult),
    ),
  ),
);

const modelsFromSettings = (
  piSettings: PiSettings,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(discovered, piSettings.customModels, EMPTY_CAPABILITIES);

export const buildInitialPiProviderSnapshot = Effect.fn("buildInitialPiProviderSnapshot")(
  function* (piSettings: PiSettings) {
    const checkedAt = yield* nowIso;
    const models = modelsFromSettings(piSettings, []);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi availability...",
      },
    });
  },
);

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = yield* nowIso;
  const fallbackModels = modelsFromSettings(piSettings, []);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runPiVersion(piSettings, environment).pipe(
    Effect.timeoutOption(PI_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

  if (version.code !== 0) {
    const detail =
      version.stderr.trim() || version.stdout.trim() || `Command exited with code ${version.code}.`;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail,
      },
    });
  }

  if (!parsedVersion || compareSemverVersions(parsedVersion, MIN_PI_VERSION) < 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: parsedVersion
          ? `Pi ${MIN_PI_VERSION} or newer is required. Installed: ${parsedVersion}.`
          : `Could not determine the Pi version. Pi ${MIN_PI_VERSION} or newer is required.`,
      },
    });
  }

  const discovery = yield* discoverPiModelsViaRpc(piSettings, cwd, environment);
  const discovered = discovery._tag === "success" ? discovery.models : [];
  const models = modelsFromSettings(piSettings, discovered);

  // Custom fallback slugs do not prove credentials; only Pi's own catalog does.
  const authenticated = discovery._tag === "success";
  const discoveryFailed = discovery._tag !== "success" && discovery._tag !== "empty";

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unknown", type: "pi" },
      ...(authenticated
        ? {}
        : {
            message: discoveryFailed
              ? "Pi model discovery failed. Check that `pi --mode rpc` can start and return an available-models response, then retry."
              : "Pi is installed but no models are available. Configure a provider or API key in ~/.pi/agent (e.g. run `pi`) so models appear.",
          }),
    },
  });
});
