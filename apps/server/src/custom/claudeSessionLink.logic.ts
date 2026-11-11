// custom: pure parts of /claude-session/<id> links (pandora fork). The imported thread has the
// shape project/AgentSessionImporter.ts writes, with the same thread id, so the two imports agree.
import {
  ClaudeSettings,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderThreadId,
  resolveProviderInstanceEnabled,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceConfig,
  type RuntimeMode,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AgentSessionThread } from "../project/AgentSessionScanner.ts";

export const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

interface ClaudeHome {
  readonly homePath: string;
  readonly providerInstanceId: ProviderInstanceId;
}

/** Enabled Claude instances and their config dirs, default instance first, as the scanner finds them. */
export function claudeHomes(input: {
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly resolve: (...segments: ReadonlyArray<string>) => string;
}): ReadonlyArray<ClaudeHome> {
  const instances = Object.entries(input.providerInstances).filter(
    ([, instance]) => instance.driver === CLAUDE_DRIVER && resolveProviderInstanceEnabled(instance),
  );
  if (!Object.hasOwn(input.providerInstances, CLAUDE_DRIVER)) {
    const fallback: ProviderInstanceConfig = { driver: CLAUDE_DRIVER };
    if (resolveProviderInstanceEnabled(fallback)) instances.push([CLAUDE_DRIVER, fallback]);
  }
  instances.sort(([left], [right]) =>
    left === CLAUDE_DRIVER ? -1 : right === CLAUDE_DRIVER ? 1 : 0,
  );
  const homes: Array<ClaudeHome> = [];
  for (const [instanceId, instance] of instances) {
    const settings = decodeClaudeSettings(instance.config ?? {});
    if (Option.isNone(settings)) continue;
    const fromInstance = instance.environment?.findLast(
      (variable) => variable.name === "CLAUDE_CONFIG_DIR",
    )?.value;
    const fromEnvironment =
      typeof fromInstance === "string" ? fromInstance : input.hostEnvironment.CLAUDE_CONFIG_DIR;
    const configured = settings.value.homePath.trim() || fromEnvironment?.trim() || "";
    const homePath =
      configured.length > 0
        ? input.resolve(expandHomePath(configured, input.homeDir))
        : input.resolve(input.homeDir, ".claude");
    if (homes.some((home) => home.homePath === homePath)) continue;
    homes.push({ homePath, providerInstanceId: ProviderInstanceId.make(instanceId) });
  }
  return homes;
}

/** The working directory Claude recorded for the session: the first record that names one. */
export function transcriptCwd(contents: string): string | null {
  for (const line of contents.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record !== "object" || record === null || !("cwd" in record)) continue;
      const cwd = record.cwd;
      if (typeof cwd === "string" && cwd.trim().length > 0) return cwd.trim();
    } catch {
      continue;
    }
  }
  return null;
}

/** Claude's title, else the first line with a word in the first user message, past front matter. */
export function importTitle(thread: AgentSessionThread): string {
  const hasWord = (line: string) => /[\p{L}\p{N}]/u.test(line);
  if (hasWord(thread.title)) return thread.title.trim();
  const firstUser = thread.messages.find((message) => message.role === "user")?.text ?? "";
  const body = firstUser.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
  const line = body.split("\n").find(hasWord)?.trim().slice(0, 100).trim();
  return line || "Imported Claude session";
}

export function importedClaudeThreadId(instanceId: ProviderInstanceId, sessionId: string) {
  return ThreadId.make(`import:${instanceId}:${sessionId}`);
}

/** Events that create the thread, its prior user and assistant messages, and the session binding. */
export function claudeSessionImportEvents(input: {
  readonly thread: AgentSessionThread;
  readonly projectId: ProjectId;
  readonly providerThreadId: ProviderThreadId;
  readonly runtimeMode: RuntimeMode;
}): {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
} {
  const { thread } = input;
  const threadId = importedClaudeThreadId(thread.providerInstanceId, thread.providerSessionId);
  const createdAt = DateTime.makeUnsafe(thread.createdAt);
  const updatedAt = DateTime.makeUnsafe(thread.updatedAt);
  const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER] ?? DEFAULT_MODEL;
  const appThread: OrchestrationV2AppThread = {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: input.projectId,
    title: importTitle(thread),
    providerInstanceId: thread.providerInstanceId,
    modelSelection: { instanceId: thread.providerInstanceId, model },
    runtimeMode: input.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: input.providerThreadId,
    // Shown before the first run, and never replayed into the resumed native session.
    historyOrigin: "v1_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: input.providerThreadId,
    driver: CLAUDE_DRIVER,
    providerInstanceId: thread.providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CLAUDE_DRIVER,
      nativeId: thread.providerSessionId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt,
    updatedAt,
  };
  const common = {
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
  };
  const notice: ReadonlyArray<OrchestrationV2DomainEvent> =
    thread.omittedMessageCount === 0
      ? []
      : [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: createdAt,
            payload: {
              ...common,
              id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
              ordinal: 0,
              startedAt: createdAt,
              completedAt: createdAt,
              updatedAt: createdAt,
              type: "system_notice",
              message: `Imported Claude session ${thread.providerSessionId}: ${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message is" : "messages are"} not shown here. Claude still has the whole conversation.`,
            },
          },
        ];
  const messages = thread.messages.flatMap((message, index): Array<OrchestrationV2DomainEvent> => {
    const suffix = String(index).padStart(6, "0");
    const messageId = MessageId.make(`${threadId}:${suffix}`);
    const at = DateTime.makeUnsafe(message.createdAt);
    const item = {
      ...common,
      id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
      ordinal: index + 1,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      messageId,
      text: message.text,
    };
    return [
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${threadId}:${suffix}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy: message.role === "user" ? "user" : "agent",
          creationSource: "server",
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: message.role,
          text: message.text,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload:
          message.role === "user"
            ? {
                ...item,
                createdBy: "user",
                creationSource: "server",
                type: "user_message",
                inputIntent: "turn_start",
                attachments: [],
              }
            : { ...item, type: "assistant_message", streaming: false },
      },
    ];
  });
  return {
    providerThread,
    events: [
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
        type: "thread.created",
        threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: createdAt,
        payload: appThread,
      },
      ...notice,
      ...messages,
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${input.providerThreadId}`),
        type: "provider-thread.updated",
        threadId,
        driver: CLAUDE_DRIVER,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: updatedAt,
        payload: providerThread,
      },
    ],
  };
}
