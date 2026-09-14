/** `ProviderAdapterShape` for the Pi coding agent (per-thread `pi --mode rpc` sessions). */
import * as NodeURL from "node:url";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ModelSelection,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  type AgentSessionEvent,
  buildPiTurnCommand,
  describePiCommandFailure,
  extractAssistantTextDelta,
  extractForkMessages,
  extractPiAssistantOutcome,
  extractPiSessionState,
  extractPiToolResultText,
  extractReasoningTextDelta,
  extractSessionFile,
  makePiRpcTransport,
  type MakePiRpcTransportOptions,
  piForkSucceeded,
  piImageContentFromBytes,
  type PiImageContent,
  type PiAssistantOutcome,
  type PiRpcObservation,
  piResponseHasCommand,
  piResponseSucceeded,
  planPiModelSwitch,
  resolveForkTargetEntryId,
  resolvePiThinkingLevel,
  type PiRpcTransport,
  type PiStdoutMessage,
  type PiThinkingLevel,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from "./PiRpcClient.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const PI_STATE_TIMEOUT_MS = 5_000;
const PI_COMMANDS_TIMEOUT_MS = 5_000;
const PI_MESSAGES_TIMEOUT_MS = 5_000;
// fork/new_session rebinds to a new session file — give it more headroom
const PI_FORK_TIMEOUT_MS = 15_000;
const PI_MODEL_OPTIONS_TIMEOUT_MS = 5_000;
const PI_TURN_COMMAND_TIMEOUT_MS = 10_000;

// keep in sync with SENTINEL_COMMAND in t3-approvals.ts
const PI_APPROVAL_SENTINEL_COMMAND = "t3-approval-gate";
// provided by the locally installed pi-mcp-adapter extension
const PI_MCP_SUPPORT_SENTINEL_COMMAND = "mcp-transient-config-supported";
const PI_MCP_ACTIVE_SENTINEL_COMMAND = "mcp-transient-config-active";
export const PI_TRANSIENT_MCP_CONFIG_ENV = "PI_MCP_ADAPTER_TRANSIENT_CONFIG";
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Full access runs ungated. Every other mode uses the bundled extension because
// Pi has no native sandbox or T3 auto-review equivalent; `auto` degrades safely
// to explicit approvals instead of silently becoming full access.
function approvalGateForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): { readonly gate: false } | { readonly gate: true; readonly mode: string } {
  if (runtimeMode === "full-access") return { gate: false };
  return {
    gate: true,
    mode: runtimeMode === "auto-accept-edits" ? runtimeMode : "approval-required",
  };
}

// dev resolves ../assets (running from src); the vp-pack build copies the asset
// next to the bundle, so prod resolves ./assets
export const PI_APPROVAL_EXTENSION_CANDIDATES: ReadonlyArray<string> = (() => {
  const resolve = (relative: string): string | undefined => {
    try {
      return NodeURL.fileURLToPath(new URL(relative, import.meta.url));
    } catch {
      return undefined;
    }
  };
  return [resolve("../assets/pi/t3-approvals.ts"), resolve("./assets/pi/t3-approvals.ts")].filter(
    (value): value is string => value !== undefined,
  );
})();

interface PiToolItem {
  readonly id: RuntimeItemId;
  readonly type: CanonicalItemType;
  readonly toolName: string;
  args: unknown;
  // last cumulative tool output text already emitted as content.delta
  emittedOutputText: string;
  // last item.updated progress fingerprint (avoids flooding activities)
  lastProgressFingerprint: string | undefined;
  lastProgressEmittedAtMs: number;
}

// work-log rows collapse tool.updated events, but each still hits the event log
const PI_TOOL_PROGRESS_MIN_INTERVAL_MS = 400;
const PI_TOOL_PROGRESS_PREVIEW_CHARS = 400;

interface PiTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<PiToolItem>;
  latestAssistantOutcome: PiAssistantOutcome | undefined;
  lastRetryError: string | undefined;
}

interface PendingApproval {
  readonly piId: string;
  readonly requestType: CanonicalRequestType;
  readonly turnId?: TurnId;
}

interface PendingUserInput {
  readonly piId: string;
  readonly questionId: string;
  readonly method: "select" | "input" | "editor";
  readonly numberedOptions?: ReadonlyArray<string>;
  readonly turnId?: TurnId;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly sessionScope: Scope.Closeable;
  readonly transport: PiRpcTransport;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly sendTurnSemaphore: Semaphore.Semaphore;
  turnState: PiTurnState | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<PiToolItem> }>;
  turnUserMessageBaselines: Array<number> | undefined;
  stopped: boolean;
  // slug the pi process is running; used to issue set_model only on change
  currentModel: string | undefined;
  appliedThinkingLevel: PiThinkingLevel | undefined;
}

// ---------------------------------------------------------------------------
// Pure classification helpers
// ---------------------------------------------------------------------------

export function classifyPiToolItemType(toolName: string): CanonicalItemType {
  // whole-token match (split camelCase/separators) so "recommend" isn't read as "command"
  const tokens = new Set(
    toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
  const has = (...words: ReadonlyArray<string>): boolean => words.some((word) => tokens.has(word));

  if (has("mcp")) return "mcp_tool_call";
  if (has("agent", "subagent", "task", "skill")) return "collab_agent_tool_call";
  if (has("bash", "shell", "command", "terminal", "exec")) return "command_execution";
  if (has("edit", "write", "patch", "apply", "file")) return "file_change";
  if (has("search", "web")) return "web_search";
  if (has("image")) return "image_view";
  return "dynamic_tool_call";
}

export function classifyPiApprovalRequestType(toolHint: string): CanonicalRequestType {
  const item = classifyPiToolItemType(toolHint);
  switch (item) {
    case "command_execution":
      return "command_execution_approval";
    case "file_change":
      return "file_change_approval";
    default:
      // a Pi confirm is a binary gate, not structured input; tool_user_input
      // would be dropped by the runtime-ingestion + web approval pipeline
      return "dynamic_tool_call";
  }
}

export function summarizePiToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const command = input["command"] ?? input["cmd"];
  if (typeof command === "string" && command.trim().length > 0) return command.trim().slice(0, 400);
  const path = input["file_path"] ?? input["path"] ?? input["filePath"];
  if (typeof path === "string" && path.trim().length > 0) return path.trim().slice(0, 400);
  const pattern = input["pattern"] ?? input["query"] ?? input["description"];
  if (typeof pattern === "string" && pattern.trim().length > 0) return pattern.trim().slice(0, 400);
  try {
    const serialized = JSON.stringify(input);
    return serialized.length <= 400 ? serialized : `${serialized.slice(0, 397)}...`;
  } catch {
    return undefined;
  }
}

export function summarizePiToolOutput(
  text: string,
  limit = PI_TOOL_PROGRESS_PREVIEW_CHARS,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function piArgsObject(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

// shape retained by ActivityPayloadProjection + web work-log extractors
export function buildPiToolActivityData(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly outputText?: string;
}): Record<string, unknown> {
  const argsObj = piArgsObject(input.args);
  const command =
    typeof argsObj?.command === "string"
      ? argsObj.command
      : typeof argsObj?.cmd === "string"
        ? argsObj.cmd
        : undefined;
  const item: Record<string, unknown> = {};
  if (command !== undefined) item.command = command;
  if (argsObj) item.input = argsObj;

  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(argsObj ? { input: argsObj } : {}),
    ...(Object.keys(item).length > 0 ? { item } : {}),
    ...(input.outputText && input.outputText.length > 0
      ? { rawOutput: { content: input.outputText } }
      : {}),
  };
}

function piToolStreamKind(
  itemType: CanonicalItemType,
): "command_output" | "file_change_output" | "unknown" {
  if (itemType === "command_execution") return "command_output";
  if (itemType === "file_change") return "file_change_output";
  return "unknown";
}

// Pi encodes an RPC multi-select as `Title\n1. A\n2. B`
export function parseNumberedList(
  text: string,
): { title: string; items: ReadonlyArray<string> } | null {
  const lines = text.split("\n");
  const items: string[] = [];
  for (const line of lines.slice(1)) {
    const match = /^\d+\.\s+(.+)$/.exec(line.trim());
    if (match?.[1]) items.push(match[1]);
  }
  return items.length >= 2 ? { title: lines[0] ?? text, items } : null;
}

export function isPiApprovalConfirmed(decision: ProviderApprovalDecision): boolean {
  return decision === "accept" || decision === "acceptForSession";
}

export function buildPiApprovalResponse(
  piId: string,
  decision: ProviderApprovalDecision,
): RpcExtensionUIResponse {
  return { type: "extension_ui_response", id: piId, confirmed: isPiApprovalConfirmed(decision) };
}

// numbered-list multi-select maps labels back to Pi's 1-based, comma-joined indices
export function buildPiUserInputResponse(
  pending: {
    readonly piId: string;
    readonly questionId: string;
    readonly method: "select" | "input" | "editor";
    readonly numberedOptions?: ReadonlyArray<string>;
  },
  answers: ProviderUserInputAnswers,
): RpcExtensionUIResponse {
  const answer = answers[pending.questionId];
  const numberedOptions = pending.numberedOptions;
  if (pending.method === "input" && numberedOptions) {
    const selected: ReadonlyArray<string> = Array.isArray(answer)
      ? answer.map(String)
      : typeof answer === "string" && answer.length > 0
        ? [answer]
        : [];
    const indices = selected
      .map((label) => {
        const idx = numberedOptions.indexOf(label);
        return idx >= 0 ? String(idx + 1) : null;
      })
      .filter((value): value is string => value !== null);
    return { type: "extension_ui_response", id: pending.piId, value: indices.join(",") };
  }
  const value = typeof answer === "string" ? answer : "";
  return { type: "extension_ui_response", id: pending.piId, value };
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return fallback;
}

function readPiResumeState(
  resumeCursor: unknown,
): { sessionFile: string; turnUserMessageBaselines: Array<number> | undefined } | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as Record<string, unknown>;
  if (typeof cursor["sessionFile"] !== "string" || cursor["sessionFile"].trim().length === 0) {
    return undefined;
  }
  const rawTurnUserMessageBaselines = cursor["turnUserMessageBaselines"];
  const turnUserMessageBaselines =
    Array.isArray(rawTurnUserMessageBaselines) &&
    rawTurnUserMessageBaselines.every(
      (count, index) =>
        Number.isInteger(count) &&
        count >= 0 &&
        (index === 0 || count >= (rawTurnUserMessageBaselines[index - 1] as number)),
    )
      ? [...rawTurnUserMessageBaselines]
      : undefined;
  return { sessionFile: cursor["sessionFile"].trim(), turnUserMessageBaselines };
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  // transport override for tests; defaults to the real `pi --mode rpc` spawn
  readonly makeTransport?: (
    options: MakePiRpcTransportOptions,
  ) => Effect.Effect<
    PiRpcTransport,
    PlatformError.PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const baseEnvironment = options?.environment ?? process.env;
  const makeTransport = options?.makeTransport ?? makePiRpcTransport;
  const nativeEventLogger = options?.nativeEventLogger;
  const transientMcpSupportByCwd = new Map<string, boolean>();

  const probeTransientMcpSupport = Effect.fn("PiAdapter.probeTransientMcpSupport")(function* (
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const cached = transientMcpSupportByCwd.get(cwd);
    if (cached !== undefined) return cached;

    const supported = yield* Effect.gen(function* () {
      const transport = yield* makeTransport({
        binaryPath: piSettings.binaryPath || "pi",
        args: ["--mode", "rpc"],
        cwd,
        env: { ...environment },
        onExit: Effect.void,
      });
      const response = yield* transport.request(
        { type: "get_commands" },
        `pi-mcp-support-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        PI_COMMANDS_TIMEOUT_MS,
      );
      yield* transport.kill;
      return piResponseHasCommand(response, PI_MCP_SUPPORT_SENTINEL_COMMAND);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.logWarning("pi.mcp-support.probe-failed", { cause }).pipe(Effect.as(false)),
      ),
    );

    transientMcpSupportByCwd.set(cwd, supported);
    return supported;
  });

  let approvalExtensionPath: string | undefined;
  for (const candidate of PI_APPROVAL_EXTENSION_CANDIDATES) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      approvalExtensionPath = candidate;
      break;
    }
  }
  const approvalExtensionAvailable = approvalExtensionPath !== undefined;

  const sessions = new Map<ThreadId, PiSessionContext>();
  const threadLocksRef = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nextEventId = Effect.map(nextUuid, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const getThreadSemaphore = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const logNative = (threadId: ThreadId, observation: PiRpcObservation) =>
    Effect.gen(function* () {
      if (!nativeEventLogger) return;
      const observedAt = yield* nowIso;
      yield* nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* nextUuid,
            kind: "notification",
            provider: PROVIDER,
            createdAt: observedAt,
            method: `pi.rpc.${observation.kind}`,
            threadId,
            payload: observation,
          },
        },
        threadId,
      );
    });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const rawEvent = (
    source: "pi.rpc.event" | "pi.rpc.extension-ui",
    method: string,
    payload: unknown,
  ) => ({ raw: { source, method, payload } }) as const;

  const completeTurn = (
    context: PiSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
    includeProviderOutcome = false,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) return;
      context.turnState = undefined;
      context.turns.push({ id: turnState.turnId, items: [...turnState.items] });

      const updatedAt = yield* nowIso;
      const { activeTurnId: _activeTurnId, ...readySession } = context.session;
      context.session = { ...readySession, status: "ready", updatedAt };

      const stamp = yield* makeEventStamp();
      const providerOutcome = includeProviderOutcome ? turnState.latestAssistantOutcome : undefined;
      const resolvedErrorMessage = errorMessage ?? providerOutcome?.errorMessage;
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          state,
          ...(providerOutcome?.stopReason ? { stopReason: providerOutcome.stopReason } : {}),
          ...(providerOutcome?.usage ? { usage: providerOutcome.usage } : {}),
          ...(providerOutcome?.totalCostUsd !== undefined
            ? { totalCostUsd: providerOutcome.totalCostUsd }
            : {}),
          ...(resolvedErrorMessage ? { errorMessage: resolvedErrorMessage } : {}),
        },
      });
    });

  const openTurn = (context: PiSessionContext): Effect.Effect<TurnId> =>
    Effect.gen(function* () {
      const turnId = TurnId.make(yield* nextUuid);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        startedAt,
        items: [],
        latestAssistantOutcome: undefined,
        lastRetryError: undefined,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId,
        type: "turn.started",
        payload: context.currentModel ? { model: context.currentModel } : {},
      });
      return turnId;
    });

  const handlePiEvent = (
    context: PiSessionContext,
    event: AgentSessionEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      const base = {
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...rawEvent("pi.rpc.event", event.type, event),
      };

      switch (event.type) {
        case "agent_start": {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: { state: "running" },
          });
          return;
        }

        case "turn_start": {
          if (!context.turnState) {
            yield* openTurn(context);
          }
          return;
        }

        case "message_update": {
          if (!context.turnState) return;
          const text = extractAssistantTextDelta(event);
          if (text !== null) {
            yield* offerRuntimeEvent({
              ...base,
              turnId: context.turnState.turnId,
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: text },
            });
            return;
          }
          const reasoning = extractReasoningTextDelta(event);
          if (reasoning !== null) {
            yield* offerRuntimeEvent({
              ...base,
              turnId: context.turnState.turnId,
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta: reasoning },
            });
          }
          return;
        }

        case "message_end":
        case "turn_end": {
          const outcome = extractPiAssistantOutcome(event);
          if (context.turnState && outcome) {
            context.turnState.latestAssistantOutcome = outcome;
          }
          return;
        }

        case "tool_execution_start": {
          if (
            !context.turnState ||
            typeof event.toolCallId !== "string" ||
            typeof event.toolName !== "string"
          ) {
            return;
          }
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const detail = summarizePiToolArgs(event.args);
          const data = buildPiToolActivityData({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          context.turnState.items.push({
            id: itemId,
            type: itemType,
            toolName: event.toolName,
            args: event.args,
            emittedOutputText: "",
            lastProgressFingerprint: undefined,
            lastProgressEmittedAtMs: 0,
          });
          // work log skips tool.started; emit inProgress updated so the row appears immediately
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress",
              title: event.toolName,
              ...(detail ? { detail } : {}),
              data,
            },
          });
          yield* offerRuntimeEvent({
            ...base,
            eventId: yield* nextEventId,
            createdAt: yield* nowIso,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.updated",
            payload: {
              itemType,
              status: "inProgress",
              title: event.toolName,
              ...(detail ? { detail } : {}),
              data,
            },
          });
          return;
        }

        case "tool_execution_update": {
          if (
            !context.turnState ||
            typeof event.toolCallId !== "string" ||
            typeof event.toolName !== "string"
          ) {
            return;
          }
          const partial = event.partialResult;
          if (partial === undefined) return;
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const accumulated = extractPiToolResultText(partial);
          if (accumulated === null || accumulated.length === 0) return;

          const storedItem = context.turnState.items.find((item) => item.id === itemId);
          const previousText = storedItem?.emittedOutputText ?? "";
          const delta =
            previousText.length > 0 && accumulated.startsWith(previousText)
              ? accumulated.slice(previousText.length)
              : accumulated;
          if (storedItem) {
            storedItem.emittedOutputText = accumulated;
          }
          if (delta.length > 0) {
            yield* offerRuntimeEvent({
              ...base,
              turnId: context.turnState.turnId,
              itemId,
              type: "content.delta",
              payload: {
                streamKind: piToolStreamKind(itemType),
                delta,
              },
            });
          }

          // throttle progress rows: collapse key is stable, but each update is still persisted
          const argsSummary = summarizePiToolArgs(storedItem?.args ?? event.args);
          const outputPreview = summarizePiToolOutput(accumulated);
          const progressDetail = argsSummary ? `${argsSummary} · ${outputPreview}` : outputPreview;
          const nowMs = yield* Clock.currentTimeMillis;
          const fingerprintChanged =
            storedItem === undefined || storedItem.lastProgressFingerprint !== progressDetail;
          const intervalElapsed =
            storedItem === undefined ||
            nowMs - storedItem.lastProgressEmittedAtMs >= PI_TOOL_PROGRESS_MIN_INTERVAL_MS;
          // first distinct preview always lands; later ones are rate-limited
          const shouldEmitProgress =
            progressDetail.length > 0 &&
            fingerprintChanged &&
            (storedItem?.lastProgressFingerprint === undefined || intervalElapsed);
          if (shouldEmitProgress) {
            if (storedItem) {
              storedItem.lastProgressFingerprint = progressDetail;
              storedItem.lastProgressEmittedAtMs = nowMs;
            }
            yield* offerRuntimeEvent({
              ...base,
              eventId: yield* nextEventId,
              createdAt: yield* nowIso,
              turnId: context.turnState.turnId,
              itemId,
              type: "item.updated",
              payload: {
                itemType,
                status: "inProgress",
                title: event.toolName,
                detail: progressDetail,
                data: buildPiToolActivityData({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: storedItem?.args ?? event.args,
                  outputText: accumulated,
                }),
              },
            });
          }
          return;
        }

        case "tool_execution_end": {
          if (
            !context.turnState ||
            typeof event.toolCallId !== "string" ||
            typeof event.toolName !== "string"
          ) {
            return;
          }
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const storedItem = context.turnState.items.find((item) => item.id === itemId);
          const argsSummary = summarizePiToolArgs(storedItem?.args);
          const resultText =
            extractPiToolResultText(event.result) ?? storedItem?.emittedOutputText ?? "";
          // flush any trailing cumulative text that never arrived as an update
          if (resultText.length > 0) {
            const previousText = storedItem?.emittedOutputText ?? "";
            const delta =
              previousText.length > 0 && resultText.startsWith(previousText)
                ? resultText.slice(previousText.length)
                : previousText === resultText
                  ? ""
                  : resultText;
            if (storedItem) {
              storedItem.emittedOutputText = resultText;
            }
            if (delta.length > 0) {
              yield* offerRuntimeEvent({
                ...base,
                eventId: yield* nextEventId,
                createdAt: yield* nowIso,
                turnId: context.turnState.turnId,
                itemId,
                type: "content.delta",
                payload: {
                  streamKind: piToolStreamKind(itemType),
                  delta,
                },
              });
            }
          }
          const outputPreview =
            resultText.length > 0 ? summarizePiToolOutput(resultText) : undefined;
          const detail =
            argsSummary && outputPreview
              ? `${argsSummary} · ${outputPreview}`
              : (outputPreview ?? argsSummary);
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.completed",
            payload: {
              itemType,
              title: event.toolName,
              status: event.isError ? "failed" : "completed",
              ...(detail ? { detail } : {}),
              data: buildPiToolActivityData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: storedItem?.args,
                ...(resultText.length > 0 ? { outputText: resultText } : {}),
              }),
            },
          });
          return;
        }

        case "agent_end": {
          // Pi can emit several internal turn/agent endings for one user prompt.
          const outcome = extractPiAssistantOutcome(event);
          if (context.turnState && outcome) {
            context.turnState.latestAssistantOutcome = outcome;
          }
          return;
        }

        case "auto_retry_start": {
          if (!context.turnState) return;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            type: "session.state.changed",
            payload: {
              state: "waiting",
              reason:
                typeof event.attempt === "number" && typeof event.maxAttempts === "number"
                  ? `retry ${event.attempt}/${event.maxAttempts}`
                  : "retry",
              detail: {
                ...(typeof event.delayMs === "number" ? { delayMs: event.delayMs } : {}),
                ...(typeof event.errorMessage === "string"
                  ? { errorMessage: event.errorMessage }
                  : {}),
              },
            },
          });
          return;
        }

        case "auto_retry_end": {
          if (!context.turnState) return;
          if (event.success === false && typeof event.finalError === "string") {
            context.turnState.lastRetryError = event.finalError;
          }
          return;
        }

        case "agent_settled": {
          if (context.turnState) {
            const outcome = context.turnState.latestAssistantOutcome;
            const state =
              outcome?.stopReason === "error"
                ? "failed"
                : outcome?.stopReason === "aborted"
                  ? "cancelled"
                  : context.turnState.lastRetryError
                    ? "failed"
                    : "completed";
            yield* completeTurn(
              context,
              state,
              outcome?.errorMessage ?? context.turnState.lastRetryError,
              true,
            );
          }
          return;
        }

        case "compaction_start": {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: { state: "waiting", reason: "compaction" },
          });
          return;
        }

        case "compaction_end": {
          yield* offerRuntimeEvent({
            ...base,
            type: "thread.state.changed",
            payload: { state: "compacted" },
          });
          return;
        }

        default:
          return;
      }
    });

  const handleExtensionUIRequest = (
    context: PiSessionContext,
    request: RpcExtensionUIRequest,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // fire-and-forget UI side-effects — Pi does not await a response
      if (
        request.method === "notify" ||
        request.method === "setStatus" ||
        request.method === "setWidget" ||
        request.method === "setTitle" ||
        request.method === "set_editor_text"
      ) {
        return;
      }

      const stamp = yield* makeEventStamp();
      const requestId = ApprovalRequestId.make(yield* nextUuid);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const turnId = context.turnState?.turnId;

      if (request.method === "confirm") {
        const requestType = classifyPiApprovalRequestType(request.title);
        const detail =
          request.message.length > 0 ? `${request.title}\n${request.message}` : request.title;
        context.pendingApprovals.set(requestId, {
          piId: request.id,
          requestType,
          ...(turnId ? { turnId } : {}),
        });
        yield* offerRuntimeEvent({
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          requestId: runtimeRequestId,
          type: "request.opened",
          payload: { requestType, detail: detail.slice(0, 2000), args: request },
          ...rawEvent("pi.rpc.extension-ui", request.method, request),
        });
        return;
      }

      const questionId = String(requestId);
      let question: UserInputQuestion;
      let numberedOptions: ReadonlyArray<string> | undefined;

      if (request.method === "select") {
        question = {
          id: questionId,
          header: request.title.slice(0, 12) || "Select",
          question: request.title,
          options: request.options.map((label) => ({ label, description: label })),
          multiSelect: false,
        };
      } else {
        const title = "title" in request ? request.title : "";
        const parsed = request.method === "input" ? parseNumberedList(title) : null;
        if (parsed) {
          numberedOptions = parsed.items;
          question = {
            id: questionId,
            header: parsed.title.slice(0, 12) || "Select",
            question: parsed.title,
            options: parsed.items.map((item) => ({ label: item, description: item })),
            multiSelect: true,
          };
        } else {
          question = {
            id: questionId,
            header: title.slice(0, 12) || "Input",
            question: title || "Input",
            options: [],
            multiSelect: false,
          };
        }
      }

      context.pendingUserInputs.set(requestId, {
        piId: request.id,
        questionId,
        method: request.method,
        ...(numberedOptions ? { numberedOptions } : {}),
        ...(turnId ? { turnId } : {}),
      });

      yield* offerRuntimeEvent({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
        requestId: runtimeRequestId,
        type: "user-input.requested",
        payload: { questions: [question] },
        ...rawEvent("pi.rpc.extension-ui", request.method, request),
      });
    });

  const handleMessage = (
    context: PiSessionContext,
    message: PiStdoutMessage,
  ): Effect.Effect<void> => {
    switch (message._tag) {
      case "event":
        return handlePiEvent(context, message.event);
      case "extension-ui":
        return handleExtensionUIRequest(context, message.request);
      case "response":
        return Effect.void;
    }
  };

  // settle+clear pending extension-UI requests so Pi is never left blocked
  const cancelPendingExtensionRequests = (context: PiSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [requestId, pending] of context.pendingApprovals) {
        yield* context.transport
          .writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            confirmed: false,
          })
          .pipe(Effect.ignoreCause({ log: false }));
        yield* offerRuntimeEvent({
          ...(yield* makeEventStamp()),
          type: "request.resolved",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: pending.requestType, decision: "cancel" },
        });
      }
      context.pendingApprovals.clear();
      for (const [requestId, pending] of context.pendingUserInputs) {
        yield* context.transport
          .writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            cancelled: true,
          })
          .pipe(Effect.ignoreCause({ log: false }));
        yield* offerRuntimeEvent({
          ...(yield* makeEventStamp()),
          type: "user-input.resolved",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: {} },
        });
      }
      context.pendingUserInputs.clear();
    });

  const stopSessionInternal = (
    context: PiSessionContext,
    opts?: {
      readonly emitExitEvent?: boolean;
      readonly exitKind?: "graceful" | "error";
      readonly reason?: string;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;

      if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);

      yield* cancelPendingExtensionRequests(context);

      if (context.turnState) {
        yield* completeTurn(context, "interrupted", "Session stopped.");
      }

      yield* Effect.ignore(Scope.close(context.sessionScope, Exit.void));

      const updatedAt = yield* nowIso;
      const { activeTurnId: _activeTurnId, ...closedSession } = context.session;
      context.session = { ...closedSession, status: "closed", updatedAt };
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }

      if (opts?.emitExitEvent !== false) {
        const exitKind = opts?.exitKind ?? "graceful";
        const reason =
          opts?.reason ??
          (exitKind === "error" ? "Pi process exited unexpectedly." : "Session stopped");
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...stamp,
          type: "session.exited",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          payload: {
            reason,
            exitKind,
            ...(exitKind === "error" ? { recoverable: false } : {}),
          },
        });
      }
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(context);
  };

  // resolve attachments before mutating turn state so a bad one fails cleanly
  const resolvePromptImages = (
    attachments: ProviderSendTurnInput["attachments"],
  ): Effect.Effect<ReadonlyArray<PiImageContent>, ProviderAdapterError> =>
    Effect.forEach(attachments ?? [], (attachment) =>
      Effect.gen(function* () {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Failed to read attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        return piImageContentFromBytes({ mimeType: attachment.mimeType, bytes });
      }),
    );

  // switch only on change; fail closed (prompt not sent) on a bad slug or rejection
  const maybeSwitchPiModel = (
    context: PiSessionContext,
    requestedModel: string | undefined,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const plan = planPiModelSwitch(context.currentModel, requestedModel);
      if (plan.kind === "noop") return;
      if (plan.kind === "invalid") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid Pi model slug '${plan.slug}'; expected 'provider/id'.`,
        });
      }
      const response = yield* context.transport.request(
        { type: "set_model", provider: plan.provider, modelId: plan.modelId },
        `pi-set-model-${yield* nextUuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(response, "set_model")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: `Pi rejected model switch to '${plan.slug}'.`,
        });
      }
      context.currentModel = plan.slug;
      context.session = { ...context.session, model: plan.slug };
      // a model switch can reset the thinking level — force re-apply next turn
      context.appliedThinkingLevel = undefined;
    });

  const applyThinkingLevel = (
    context: PiSessionContext,
    modelSelection: ModelSelection | null | undefined,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const level = resolvePiThinkingLevel(modelSelection);
      if (level === undefined || level === context.appliedThinkingLevel) return;
      const response = yield* context.transport.request(
        { type: "set_thinking_level", level },
        `pi-set-thinking-${yield* nextUuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(response, "set_thinking_level")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_thinking_level",
          detail: `Pi rejected thinking level '${level}'.`,
        });
      }
      const stateResponse = yield* context.transport.request(
        { type: "get_state" },
        `pi-get-state-${yield* nextUuid}`,
        PI_STATE_TIMEOUT_MS,
      );
      if (extractPiSessionState(stateResponse)?.thinkingLevel !== level) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_thinking_level",
          detail: `Pi did not apply thinking level '${level}'.`,
        });
      }
      context.appliedThinkingLevel = level;
    });

  const startSessionUnlocked = Effect.fn("startSession")(function* (
    input: Parameters<PiAdapterShape["startSession"]>[0],
  ) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const existing = sessions.get(input.threadId);
    if (existing) {
      yield* stopSessionInternal(existing, { emitExitEvent: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pi.session.replace.stop-failed", { threadId: input.threadId, cause }),
        ),
      );
    }

    const startedAt = yield* nowIso;
    const threadId = input.threadId;
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;
    const resumeState = readPiResumeState(input.resumeCursor);
    const cwd = input.cwd ?? serverConfig.cwd;
    const thinkingLevel = resolvePiThinkingLevel(modelSelection);

    const spawnArgs: string[] = ["--mode", "rpc"];
    if (resumeState) spawnArgs.push("--session", resumeState.sessionFile);
    if (modelSelection?.model) spawnArgs.push("--model", modelSelection.model);
    if (thinkingLevel) spawnArgs.push("--thinking", thinkingLevel);

    // Never forward an ambient transient credential from the T3 parent process.
    const processEnv = { ...baseEnvironment };
    delete processEnv[PI_TRANSIENT_MCP_CONFIG_ENV];

    const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
    const matchingMcpSession =
      mcpSession?.providerInstanceId === boundInstanceId ? mcpSession : undefined;
    const injectMcpBridge = matchingMcpSession
      ? yield* probeTransientMcpSupport(cwd, processEnv)
      : false;

    // gate driven by runtimeMode; if required, must be provably active or we fail closed
    const approvalGate = approvalGateForRuntimeMode(input.runtimeMode);
    let verifyApprovalGate = false;
    if (approvalGate.gate) {
      if (!approvalExtensionAvailable || !approvalExtensionPath) {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail:
            "Tool approval is required for this runtime mode but the bundled approval gate is unavailable; refusing to start an ungated Pi session.",
        });
      }
      spawnArgs.push("--extension", approvalExtensionPath);
      processEnv["T3_PI_APPROVAL_MODE"] = approvalGate.mode;
      verifyApprovalGate = true;
    }

    if (injectMcpBridge && matchingMcpSession) {
      processEnv[PI_TRANSIENT_MCP_CONFIG_ENV] = encodeUnknownJson({
        mcpServers: {
          "t3-code": {
            url: matchingMcpSession.endpoint,
            headers: { Authorization: matchingMcpSession.authorizationHeader },
            oauth: false,
            lifecycle: "lazy",
          },
        },
      });
    }

    const sessionScope = yield* Scope.make();
    let context: PiSessionContext | undefined;
    let sessionScopeTransferred = false;
    yield* Effect.addFinalizer(() => {
      if (sessionScopeTransferred) return Effect.void;
      return context
        ? stopSessionInternal(context, { emitExitEvent: false })
        : Effect.ignore(Scope.close(sessionScope, Exit.void));
    });

    const transport = yield* makeTransport({
      binaryPath: piSettings.binaryPath || "pi",
      args: spawnArgs,
      cwd,
      env: processEnv,
      ...(nativeEventLogger
        ? { onObservation: (observation: PiRpcObservation) => logNative(threadId, observation) }
        : {}),
      onExit: Effect.suspend(() => {
        if (!context || context.stopped) return Effect.void;
        return withThreadLock(
          threadId,
          Effect.suspend(() => {
            if (
              !context ||
              sessions.get(threadId) !== context ||
              context.stopped ||
              context.session.status === "closed"
            ) {
              return Effect.void;
            }
            const drainNotifications = context.notificationFiber
              ? Fiber.join(context.notificationFiber).pipe(Effect.ignore)
              : Effect.void;
            return drainNotifications.pipe(
              Effect.andThen(
                stopSessionInternal(context, { emitExitEvent: true, exitKind: "error" }),
              ),
            );
          }),
        );
      }),
    }).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to start Pi RPC process."),
            cause,
          }),
      ),
    );

    const session: ProviderSession = {
      threadId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const sendTurnSemaphore = yield* Semaphore.make(1);

    const startedContext: PiSessionContext = {
      session,
      sessionScope,
      transport,
      notificationFiber: undefined,
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      sendTurnSemaphore,
      turnState: undefined,
      turns: [],
      turnUserMessageBaselines: resumeState?.turnUserMessageBaselines ?? [],
      stopped: false,
      currentModel: modelSelection?.model,
      appliedThinkingLevel: thinkingLevel,
    };
    context = startedContext;
    sessions.set(threadId, startedContext);

    const notificationFiber = yield* Stream.fromQueue(transport.messages).pipe(
      Stream.mapEffect((message) => handleMessage(startedContext, message)),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logError("Failed to process Pi runtime message.", { cause }),
      ),
      Effect.forkIn(sessionScope),
    );
    startedContext.notificationFiber = notificationFiber;

    const stateResponse = yield* transport.request(
      { type: "get_state" },
      `pi-get-state-${yield* nextUuid}`,
      PI_STATE_TIMEOUT_MS,
    );
    if (!piResponseSucceeded(stateResponse, "get_state") || (yield* transport.isClosed)) {
      yield* stopSessionInternal(startedContext, { emitExitEvent: false });
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: "Pi RPC process exited during session startup.",
      });
    }
    const piState = extractPiSessionState(stateResponse) ?? {};
    if (modelSelection?.model && piState.model !== modelSelection.model) {
      yield* stopSessionInternal(startedContext, { emitExitEvent: false });
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: `Pi started with model '${piState.model ?? "none"}' instead of '${modelSelection.model}'.`,
      });
    }
    if (thinkingLevel && piState.thinkingLevel !== thinkingLevel) {
      yield* stopSessionInternal(startedContext, { emitExitEvent: false });
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: `Pi started with thinking level '${piState.thinkingLevel ?? "unknown"}' instead of '${thinkingLevel}'.`,
      });
    }
    const sessionFile = piState.sessionFile;
    if (!sessionFile) {
      yield* stopSessionInternal(startedContext, { emitExitEvent: false });
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: "Pi did not provide a durable session file during startup.",
      });
    }
    startedContext.currentModel = piState.model ?? modelSelection?.model;
    startedContext.appliedThinkingLevel = piState.thinkingLevel ?? thinkingLevel;
    startedContext.session = {
      ...startedContext.session,
      ...(startedContext.currentModel ? { model: startedContext.currentModel } : {}),
      resumeCursor: {
        sessionFile,
        ...(startedContext.turnUserMessageBaselines
          ? { turnUserMessageBaselines: [...startedContext.turnUserMessageBaselines] }
          : {}),
      },
    };

    // fail closed unless injected extensions registered their sentinel commands
    if (verifyApprovalGate || injectMcpBridge) {
      const commandsResponse = yield* transport.request(
        { type: "get_commands" },
        `pi-get-commands-${yield* nextUuid}`,
        PI_COMMANDS_TIMEOUT_MS,
      );
      if (
        verifyApprovalGate &&
        !piResponseHasCommand(commandsResponse, PI_APPROVAL_SENTINEL_COMMAND, approvalExtensionPath)
      ) {
        yield* stopSessionInternal(startedContext, { emitExitEvent: false });
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail:
            "Tool approval is enabled but the approval gate failed to load; refusing to run an ungated Pi session.",
        });
      }
      if (
        injectMcpBridge &&
        !piResponseHasCommand(commandsResponse, PI_MCP_ACTIVE_SENTINEL_COMMAND)
      ) {
        yield* stopSessionInternal(startedContext, { emitExitEvent: false });
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail:
            "T3 MCP credentials were provided to Pi but the MCP adapter did not consume them; refusing to start the session.",
        });
      }
    }

    if (yield* transport.isClosed) {
      yield* stopSessionInternal(startedContext, { emitExitEvent: false });
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: "Pi RPC process exited during session startup.",
      });
    }

    const startedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...startedStamp,
      type: "session.started",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: {},
    });

    // session file is the provider-native thread id — publish for provider_thread_id parity
    if (sessionFile !== undefined) {
      const threadStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...threadStartedStamp,
        type: "thread.started",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId,
        payload: { providerThreadId: sessionFile },
      });
    }

    const configuredStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...configuredStamp,
      type: "session.configured",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: {
        config: {
          ...(startedContext.currentModel ? { model: startedContext.currentModel } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
      },
    });

    const readyStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...readyStamp,
      type: "session.state.changed",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: { state: "ready" },
    });

    sessionScopeTransferred = true;
    return { ...startedContext.session };
  });

  const startSession: PiAdapterShape["startSession"] = (input) =>
    withThreadLock(input.threadId, startSessionUnlocked(input).pipe(Effect.scoped));

  const sendTurnUnlocked = Effect.fn("sendTurn")(function* (
    input: Parameters<PiAdapterShape["sendTurn"]>[0],
  ) {
    const context = yield* requireSession(input.threadId);

    return yield* context.sendTurnSemaphore.withPermit(
      Effect.gen(function* () {
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const requestedModel = modelSelection?.model;
        const promptText = typeof input.input === "string" ? input.input : "";
        // resolve before mutating turn state so a bad attachment fails cleanly
        const images = yield* resolvePromptImages(input.attachments);

        if (promptText.length === 0 && images.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi turns require non-empty text or at least one attachment.",
          });
        }

        // reconcile local turn bookkeeping with Pi — a missed agent_settled leaves a
        // stale turnState, and a bare prompt while Pi is streaming is rejected
        const stateResponse = yield* context.transport.request(
          { type: "get_state" },
          `pi-get-state-${yield* nextUuid}`,
          PI_STATE_TIMEOUT_MS,
        );
        if (
          !piResponseSucceeded(stateResponse, "get_state") ||
          (yield* context.transport.isClosed)
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "get_state",
            detail: describePiCommandFailure(stateResponse, "get_state"),
          });
        }
        const reportedStreaming = extractPiSessionState(stateResponse)?.isStreaming;
        // explicit false clears a stale local turn; undefined keeps legacy local bookkeeping
        if (context.turnState && reportedStreaming === false) {
          yield* completeTurn(context, "interrupted");
        }
        const isMidTurn =
          reportedStreaming === true ||
          (reportedStreaming === undefined && context.turnState !== undefined);

        // only on a fresh turn — changing options mid-stream would race the active turn
        if (!isMidTurn) {
          yield* maybeSwitchPiModel(context, requestedModel);
          yield* applyThinkingLevel(context, modelSelection);
        }

        const hadTurnState = context.turnState !== undefined;
        let userMessageBaseline: number | undefined;
        if (!hadTurnState && context.turnUserMessageBaselines !== undefined) {
          const forkMessagesResponse = yield* context.transport.request(
            { type: "get_fork_messages" },
            `pi-turn-baseline-${yield* nextUuid}`,
            PI_MESSAGES_TIMEOUT_MS,
          );
          const forkMessages = extractForkMessages(forkMessagesResponse);
          if (forkMessages === undefined) {
            // Sending the turn still works, but destructive rollback is no longer provably safe.
            context.turnUserMessageBaselines = undefined;
          } else {
            userMessageBaseline = forkMessages.length;
          }
        }
        if (!context.turnState) {
          yield* openTurn(context);
        }

        const turnId = context.turnState!.turnId;

        const command = buildPiTurnCommand({
          isMidTurn,
          message: promptText,
          images,
        });
        const response = yield* context.transport.request(
          command,
          `pi-${command.type}-${yield* nextUuid}`,
          PI_TURN_COMMAND_TIMEOUT_MS,
        );
        if (!piResponseSucceeded(response, command.type)) {
          // unwind a turn we opened for this send so the next message is not stuck mid-turn
          if (!hadTurnState && context.turnState?.turnId === turnId) {
            yield* completeTurn(
              context,
              "failed",
              describePiCommandFailure(response, command.type),
            );
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: command.type,
            detail: describePiCommandFailure(response, command.type),
          });
        }

        if (
          !hadTurnState &&
          userMessageBaseline !== undefined &&
          context.turnUserMessageBaselines !== undefined
        ) {
          context.turnUserMessageBaselines.push(userMessageBaseline);
        }
        const resumeState = readPiResumeState(context.session.resumeCursor);
        if (resumeState) {
          context.session = {
            ...context.session,
            resumeCursor: {
              sessionFile: resumeState.sessionFile,
              ...(context.turnUserMessageBaselines
                ? { turnUserMessageBaselines: [...context.turnUserMessageBaselines] }
                : {}),
            },
          };
        }

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      }),
    );
  });

  const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
    withThreadLock(input.threadId, sendTurnUnlocked(input));

  const interruptTurnUnlocked = Effect.fn("interruptTurn")(function* (threadId: ThreadId) {
    const context = yield* requireSession(threadId);
    // settle bridged requests first so Pi cannot remain blocked in extension UI
    yield* cancelPendingExtensionRequests(context);
    const response = yield* context.transport.request(
      { type: "abort" },
      `pi-abort-${yield* nextUuid}`,
      PI_TURN_COMMAND_TIMEOUT_MS,
    );
    if (!piResponseSucceeded(response, "abort")) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "abort",
        detail: "Pi rejected or failed to acknowledge the interrupt.",
      });
    }
    // Abort settles Pi's agent loop and may race with a final extension request.
    yield* cancelPendingExtensionRequests(context);
    yield* completeTurn(context, "interrupted");
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
    withThreadLock(threadId, interruptTurnUnlocked(threadId));

  const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision: ProviderApprovalDecision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown pending approval request: ${requestId}.`,
        });
      }
      const response: RpcExtensionUIResponse = buildPiApprovalResponse(pending.piId, decision);
      yield* context.transport.writeExtensionResponse(response).pipe(
        Effect.catchCause(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToRequest",
              detail: "Failed to deliver the approval response to Pi.",
              cause,
            }),
        ),
      );
      context.pendingApprovals.delete(requestId);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        type: "request.resolved",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: pending.requestType, decision },
      });
    },
  );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn("respondToUserInput")(
    function* (threadId, requestId, answers: ProviderUserInputAnswers) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Unknown pending user-input request: ${requestId}.`,
        });
      }
      const response: RpcExtensionUIResponse = buildPiUserInputResponse(pending, answers);

      yield* context.transport.writeExtensionResponse(response).pipe(
        Effect.catchCause(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToUserInput",
              detail: "Failed to deliver the user-input response to Pi.",
              cause,
            }),
        ),
      );
      context.pendingUserInputs.delete(requestId);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        type: "user-input.resolved",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
    },
  );

  const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
    const context = yield* requireSession(threadId);
    return {
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    };
  });

  const rollbackThreadUnlocked = Effect.fn("rollbackThread")(function* (
    threadId: ThreadId,
    numTurns: number,
  ) {
    const context = yield* requireSession(threadId);

    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "numTurns must be an integer >= 1.",
      });
    }

    if (context.turnUserMessageBaselines === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_fork_messages",
        detail:
          "Pi cannot safely roll back this session because its user-message baseline is unavailable.",
      });
    }
    if (numTurns > context.turnUserMessageBaselines.length) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_fork_messages",
        detail: "Pi does not have enough correlated turn history for this rollback.",
      });
    }
    const firstRemovedTurnIndex = context.turnUserMessageBaselines.length - numTurns;
    const userMessageBaseline = context.turnUserMessageBaselines[firstRemovedTurnIndex]!;

    // forking mid-stream is undefined — abort/finalize any live turn first
    if (context.turnState) {
      const abortResponse = yield* context.transport.request(
        { type: "abort" },
        `pi-rollback-abort-${yield* nextUuid}`,
        PI_TURN_COMMAND_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(abortResponse, "abort")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "abort",
          detail: "Pi failed to stop the active turn before rollback.",
        });
      }
      yield* completeTurn(context, "interrupted", "Turn interrupted for rollback.");
    }

    const forkResponse = yield* context.transport.request(
      { type: "get_fork_messages" },
      `pi-fork-messages-${yield* nextUuid}`,
      PI_MESSAGES_TIMEOUT_MS,
    );
    const userMessages = extractForkMessages(forkResponse);
    if (userMessages === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_fork_messages",
        detail: "Pi failed to return rollback history.",
      });
    }
    if (userMessageBaseline > userMessages.length) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_fork_messages",
        detail: "Pi rollback history does not match the recorded T3 turn history.",
      });
    }
    const removedUserMessageCount = userMessages.length - userMessageBaseline;
    let sessionFile = readPiResumeState(context.session.resumeCursor)?.sessionFile;
    if (removedUserMessageCount > 0) {
      const target = resolveForkTargetEntryId(userMessages, removedUserMessageCount);
      if (target === null) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_fork_messages",
          detail: "Pi returned no fork target for the requested rollback.",
        });
      }

      // fork branches before the target message; new_session resets past the first
      const rollbackResponse =
        target.kind === "fork"
          ? yield* context.transport.request(
              { type: "fork", entryId: target.entryId },
              `pi-fork-${yield* nextUuid}`,
              PI_FORK_TIMEOUT_MS,
            )
          : yield* context.transport.request(
              { type: "new_session" },
              `pi-new-session-${yield* nextUuid}`,
              PI_FORK_TIMEOUT_MS,
            );
      if (!piForkSucceeded(rollbackResponse)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: target.kind === "fork" ? "fork" : "new_session",
          detail: "Pi rejected or cancelled the rollback.",
        });
      }

      // fork/new_session rebinds to a new session file — refresh it before returning.
      const stateResponse = yield* context.transport.request(
        { type: "get_state" },
        `pi-get-state-${yield* nextUuid}`,
        PI_STATE_TIMEOUT_MS,
      );
      sessionFile = extractSessionFile(stateResponse);
      if (!sessionFile) {
        yield* stopSessionInternal(context, { emitExitEvent: false });
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_state",
          detail: "Pi completed the rollback but did not provide its new durable session file.",
        });
      }
    }
    if (!sessionFile) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_state",
        detail: "Pi has no durable session file for the rollback result.",
      });
    }

    context.turnUserMessageBaselines.splice(firstRemovedTurnIndex, numTurns);
    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "ready",
      updatedAt,
      resumeCursor: {
        sessionFile,
        turnUserMessageBaselines: [...context.turnUserMessageBaselines],
      },
    };

    context.turns.splice(Math.max(0, context.turns.length - numTurns));

    return {
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      resumeCursor: context.session.resumeCursor,
    };
  });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    withThreadLock(threadId, rollbackThreadUnlocked(threadId, numTurns));

  const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, { emitExitEvent: true });
      }),
    );

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAllSessions = (emitExitEvent: boolean) =>
    Effect.forEach(
      Array.from(sessions.keys()),
      (threadId) =>
        withThreadLock(
          threadId,
          Effect.suspend(() => {
            const context = sessions.get(threadId);
            return context ? stopSessionInternal(context, { emitExitEvent }) : Effect.void;
          }),
        ),
      {
        discard: true,
      },
    );

  const stopAll: PiAdapterShape["stopAll"] = () => stopAllSessions(true);

  yield* Effect.addFinalizer(() =>
    stopAllSessions(false).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies PiAdapterShape;
});
